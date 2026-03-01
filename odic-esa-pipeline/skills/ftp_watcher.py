"""
ODIC ESA Pipeline - FTP Watcher Skill

Monitors an FTP/SFTP server for new files, downloads them to a local
staging directory, and hands them off to the pipeline for processing.
"""

import os
import stat
import asyncio
import hashlib
from pathlib import Path
from datetime import datetime
from typing import Any, Dict, List, Optional, Set, Callable, Awaitable
from dataclasses import dataclass

import paramiko

from .base import BaseSkill, SkillResult
from core.state import StateManager


@dataclass
class RemoteFile:
    """Represents a file on the remote FTP server."""
    filename: str
    path: str
    size: int
    mtime: float
    is_dir: bool


class FTPWatcher(BaseSkill):
    """
    Monitors FTP/SFTP directory for new files.

    Features:
    - SFTP support via paramiko
    - Configurable poll interval
    - Tracks seen files to avoid reprocessing
    - Downloads to local staging directory
    - Callback-based notification when new files arrive
    """

    def __init__(
        self,
        config: dict,
        state_manager: Optional[StateManager] = None,
        on_new_file: Optional[Callable[[str], Awaitable[None]]] = None
    ):
        """
        Initialize the FTP watcher.

        Args:
            config: Configuration dictionary
            state_manager: Optional StateManager for tracking
            on_new_file: Async callback when new file is downloaded
        """
        super().__init__(config)

        # FTP configuration
        ftp_config = config.get("ftp", {})
        self.host = ftp_config.get("host", "")
        self.port = ftp_config.get("port", 22)
        self.username = ftp_config.get("username", "")
        self.password = ftp_config.get("password", "")
        self.watch_directory = ftp_config.get("watch_directory", "/incoming")
        self.poll_interval = ftp_config.get("poll_interval_seconds", 30)

        # Password from environment variable if not in config
        if not self.password:
            self.password = os.environ.get("FTP_PASSWORD", "")

        # Local staging directory
        pipeline_config = config.get("pipeline", {})
        self.staging_dir = Path(
            pipeline_config.get("staging_dir", "./staging")
        )
        self.staging_dir.mkdir(parents=True, exist_ok=True)

        # State tracking
        self.state_manager = state_manager
        self.seen_files: Set[str] = set()  # Hash of (path, size, mtime)
        self._load_seen_files()

        # Callbacks
        self.on_new_file = on_new_file

        # Connection state
        self._transport: Optional[paramiko.Transport] = None
        self._sftp: Optional[paramiko.SFTPClient] = None
        self._running = False

    def _load_seen_files(self):
        """Load previously seen files from state manager."""
        if self.state_manager:
            # Get all documents that have been processed
            try:
                pending = self.state_manager.get_pending_documents()
                for doc in pending:
                    # Use original path as seen key
                    self.seen_files.add(doc.original_path)
            except Exception as e:
                self.logger.warning(f"Could not load seen files from state: {e}")

    def _file_key(self, remote_file: RemoteFile) -> str:
        """Generate unique key for a remote file."""
        return hashlib.md5(
            f"{remote_file.path}:{remote_file.size}:{remote_file.mtime}".encode()
        ).hexdigest()

    def validate_input(self, input_data: Any) -> bool:
        """
        Validate watcher can connect to FTP.

        Input is ignored - this validates configuration.
        """
        if not self.host:
            self.logger.error("FTP host not configured")
            return False
        if not self.username:
            self.logger.error("FTP username not configured")
            return False
        return True

    def _connect(self) -> bool:
        """Establish SFTP connection."""
        try:
            self.logger.info(f"Connecting to {self.host}:{self.port}")

            self._transport = paramiko.Transport((self.host, self.port))
            self._transport.connect(
                username=self.username,
                password=self.password
            )
            self._sftp = paramiko.SFTPClient.from_transport(self._transport)

            self.logger.info("SFTP connection established")
            return True

        except Exception as e:
            self.logger.error(f"SFTP connection failed: {e}")
            self._disconnect()
            return False

    def _disconnect(self):
        """Close SFTP connection."""
        try:
            if self._sftp:
                self._sftp.close()
            if self._transport:
                self._transport.close()
        except Exception:
            pass
        finally:
            self._sftp = None
            self._transport = None

    def _ensure_connected(self) -> bool:
        """Ensure SFTP connection is active."""
        if self._sftp is None or self._transport is None:
            return self._connect()

        # Check if connection is still alive
        try:
            self._sftp.stat(self.watch_directory)
            return True
        except Exception:
            self._disconnect()
            return self._connect()

    def _list_remote_files(self) -> List[RemoteFile]:
        """List files in the remote watch directory."""
        if not self._ensure_connected():
            return []

        try:
            files = []
            for entry in self._sftp.listdir_attr(self.watch_directory):
                is_dir = stat.S_ISDIR(entry.st_mode)
                if not is_dir:  # Only process files
                    remote_path = f"{self.watch_directory}/{entry.filename}"
                    files.append(RemoteFile(
                        filename=entry.filename,
                        path=remote_path,
                        size=entry.st_size,
                        mtime=entry.st_mtime,
                        is_dir=is_dir
                    ))

            return files

        except Exception as e:
            self.logger.error(f"Failed to list remote directory: {e}")
            return []

    def _download_file(self, remote_file: RemoteFile) -> Optional[Path]:
        """
        Download a file from SFTP to local staging.

        Args:
            remote_file: Remote file to download

        Returns:
            Local path to downloaded file, or None on failure
        """
        if not self._ensure_connected():
            return None

        try:
            # Create timestamped subdirectory for this batch
            batch_dir = self.staging_dir / datetime.now().strftime("%Y%m%d")
            batch_dir.mkdir(parents=True, exist_ok=True)

            local_path = batch_dir / remote_file.filename

            # Handle duplicate filenames
            if local_path.exists():
                stem = local_path.stem
                suffix = local_path.suffix
                counter = 1
                while local_path.exists():
                    local_path = batch_dir / f"{stem}_{counter}{suffix}"
                    counter += 1

            self.logger.info(f"Downloading: {remote_file.filename}")
            self._sftp.get(remote_file.path, str(local_path))

            # Verify download
            if local_path.exists() and local_path.stat().st_size == remote_file.size:
                self.logger.info(f"Downloaded: {local_path}")
                return local_path
            else:
                self.logger.error(f"Download verification failed: {remote_file.filename}")
                if local_path.exists():
                    local_path.unlink()
                return None

        except Exception as e:
            self.logger.error(f"Download failed for {remote_file.filename}: {e}")
            return None

    async def _check_for_new_files(self) -> List[Path]:
        """
        Check for new files and download them.

        Returns:
            List of paths to newly downloaded files
        """
        new_files = []

        remote_files = self._list_remote_files()
        self.logger.debug(f"Found {len(remote_files)} files on remote")

        for remote_file in remote_files:
            # Skip already-seen files
            file_key = self._file_key(remote_file)
            if file_key in self.seen_files:
                continue

            # Skip non-PDF files (configurable in future)
            if not remote_file.filename.lower().endswith(".pdf"):
                self.logger.debug(f"Skipping non-PDF: {remote_file.filename}")
                continue

            # Download the file
            local_path = self._download_file(remote_file)
            if local_path:
                new_files.append(local_path)
                self.seen_files.add(file_key)

                # Track in state manager
                if self.state_manager:
                    self.state_manager.add_document(str(local_path))

                # Notify callback
                if self.on_new_file:
                    try:
                        await self.on_new_file(str(local_path))
                    except Exception as e:
                        self.logger.error(f"Callback failed for {local_path}: {e}")

        return new_files

    async def process(self, input_data: Any = None) -> SkillResult:
        """
        Perform a single check for new files.

        Args:
            input_data: Ignored (uses configured FTP settings)

        Returns:
            SkillResult with list of new files found
        """
        if not self.validate_input(input_data):
            return SkillResult.fail(
                error="FTP configuration invalid",
                data={"host": self.host, "directory": self.watch_directory}
            )

        try:
            new_files = await self._check_for_new_files()

            return SkillResult.ok(
                data={
                    "new_files": [str(f) for f in new_files],
                    "count": len(new_files),
                    "watch_directory": self.watch_directory,
                },
                poll_interval=self.poll_interval,
            )

        except Exception as e:
            self.logger.exception(f"FTP watch failed: {e}")
            return SkillResult.fail(
                error=f"FTP watch failed: {str(e)}",
                data={"host": self.host, "directory": self.watch_directory}
            )

    async def watch(self, duration_seconds: Optional[int] = None):
        """
        Continuously watch for new files.

        Args:
            duration_seconds: Optional max duration (None = indefinite)
        """
        self._running = True
        start_time = datetime.now()

        self.logger.info(
            f"Starting FTP watch on {self.host}:{self.watch_directory} "
            f"(poll interval: {self.poll_interval}s)"
        )

        try:
            while self._running:
                # Check for new files
                result = await self.process()

                if result.success and result.data["count"] > 0:
                    self.logger.info(
                        f"Found {result.data['count']} new file(s)"
                    )

                # Check duration limit
                if duration_seconds:
                    elapsed = (datetime.now() - start_time).total_seconds()
                    if elapsed >= duration_seconds:
                        self.logger.info("Watch duration limit reached")
                        break

                # Wait for next poll
                await asyncio.sleep(self.poll_interval)

        finally:
            self._running = False
            self._disconnect()
            self.logger.info("FTP watch stopped")

    def stop(self):
        """Stop the watch loop."""
        self._running = False

    def get_model(self) -> Optional[str]:
        """FTP watcher doesn't use LLM."""
        return None


class LocalDirectoryWatcher(BaseSkill):
    """
    Alternative watcher for local directories (no FTP).

    Useful for testing or when FTP server is mounted locally.
    """

    def __init__(
        self,
        config: dict,
        state_manager: Optional[StateManager] = None,
        on_new_file: Optional[Callable[[str], Awaitable[None]]] = None
    ):
        """Initialize local directory watcher."""
        super().__init__(config)

        pipeline_config = config.get("pipeline", {})
        self.watch_directory = Path(
            config.get("local_watch_dir",
            pipeline_config.get("staging_dir", "./staging"))
        )
        self.watch_directory.mkdir(parents=True, exist_ok=True)

        self.poll_interval = config.get("ftp", {}).get(
            "poll_interval_seconds", 30
        )

        self.state_manager = state_manager
        self.on_new_file = on_new_file
        self.seen_files: Set[str] = set()
        self._running = False

    def validate_input(self, input_data: Any) -> bool:
        """Validate watch directory exists."""
        return self.watch_directory.exists()

    async def process(self, input_data: Any = None) -> SkillResult:
        """Check for new files in local directory."""
        new_files = []

        try:
            for file_path in self.watch_directory.glob("**/*.pdf"):
                file_key = str(file_path.resolve())

                if file_key in self.seen_files:
                    continue

                # Check if already processed via state manager
                if self.state_manager:
                    if self.state_manager.is_document_processed(str(file_path)):
                        self.seen_files.add(file_key)
                        continue

                new_files.append(file_path)
                self.seen_files.add(file_key)

                # Track in state manager
                if self.state_manager:
                    self.state_manager.add_document(str(file_path))

                # Notify callback
                if self.on_new_file:
                    await self.on_new_file(str(file_path))

            return SkillResult.ok(
                data={
                    "new_files": [str(f) for f in new_files],
                    "count": len(new_files),
                    "watch_directory": str(self.watch_directory),
                }
            )

        except Exception as e:
            return SkillResult.fail(
                error=f"Local watch failed: {str(e)}",
                data={"directory": str(self.watch_directory)}
            )

    async def watch(self, duration_seconds: Optional[int] = None):
        """Continuously watch for new files."""
        self._running = True
        start_time = datetime.now()

        self.logger.info(
            f"Starting local watch on {self.watch_directory} "
            f"(poll interval: {self.poll_interval}s)"
        )

        try:
            while self._running:
                result = await self.process()

                if result.success and result.data["count"] > 0:
                    self.logger.info(f"Found {result.data['count']} new file(s)")

                if duration_seconds:
                    elapsed = (datetime.now() - start_time).total_seconds()
                    if elapsed >= duration_seconds:
                        break

                await asyncio.sleep(self.poll_interval)

        finally:
            self._running = False
            self.logger.info("Local watch stopped")

    def stop(self):
        """Stop the watch loop."""
        self._running = False

    def get_model(self) -> Optional[str]:
        """Local watcher doesn't use LLM."""
        return None

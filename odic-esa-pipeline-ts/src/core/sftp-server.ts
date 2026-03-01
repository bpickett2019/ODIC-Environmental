/**
 * Local SFTP Server & Folder Watcher for dev/testing.
 *
 * Two modes of operation:
 *   1. "sftp"   — Runs a local SFTP server on port 2222 (configurable).
 *                  Accepts file uploads into ./incoming/{project-id}/ and emits
 *                  events when PDFs arrive.
 *   2. "folder" — Watches a local directory for new files (no network needed).
 *                  Useful for quick testing by dropping files into the folder.
 *
 * Both modes emit the same `file-received` event so downstream consumers
 * don't need to know the source.
 *
 * Usage:
 *   const receiver = new FileReceiver(config);
 *   receiver.on('file-received', (event) => { ... });
 *   await receiver.start();
 */

import { EventEmitter } from 'events';
import fs from 'fs/promises';
import {
  existsSync,
  mkdirSync,
  statSync,
  fstatSync,
  openSync,
  closeSync,
  readSync,
  writeSync,
  unlinkSync,
  readdirSync,
  type FSWatcher,
} from 'fs';
import path from 'path';
import crypto from 'crypto';
import pino from 'pino';
import ssh2 from 'ssh2';

import type { AppConfig, FTPConfig, SFTPServerConfig, FileReceivedEvent } from '../types/index.js';

const logger = pino({ name: 'SFTPServer', level: process.env.LOG_LEVEL || 'info' });

// ── Constants ────────────────────────────────────────────────────────────────

/** Regex to match ODIC project numbering convention (e.g. "6384578-ESAI-SiteName") */
const PROJECT_ID_PATTERN = /^(\d{5,10})-([A-Z]{2,6})-/;

/** Default SFTP server settings */
const DEFAULTS: SFTPServerConfig = {
  enabled: true,
  port: 2222,
  username: 'odic',
  password: 'odic-dev',
  host_key_path: './.ssh/host_key',
};

// ── Types ────────────────────────────────────────────────────────────────────

export interface FileReceiverEvents {
  'file-received': (event: FileReceivedEvent) => void;
  'error': (error: Error) => void;
  'started': (mode: 'sftp' | 'folder') => void;
  'stopped': () => void;
  'connection': (info: { username: string; ip: string }) => void;
}

export declare interface FileReceiver {
  on<E extends keyof FileReceiverEvents>(event: E, listener: FileReceiverEvents[E]): this;
  emit<E extends keyof FileReceiverEvents>(event: E, ...args: Parameters<FileReceiverEvents[E]>): boolean;
  off<E extends keyof FileReceiverEvents>(event: E, listener: FileReceiverEvents[E]): this;
}

// ── SSH Host Key Generation ──────────────────────────────────────────────────

/**
 * Generate an RSA SSH host key pair and store it at the given path.
 * Creates the parent directory if it doesn't exist.
 */
async function generateHostKey(keyPath: string): Promise<Buffer> {
  const dir = path.dirname(keyPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    logger.info({ dir }, 'Created SSH key directory');
  }

  logger.info({ keyPath }, 'Generating SSH host key (first run)...');

  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  await fs.writeFile(keyPath, privateKey, { mode: 0o600 });
  logger.info({ keyPath }, 'SSH host key generated and saved');

  return Buffer.from(privateKey);
}

/**
 * Load or generate the SSH host key.
 */
async function loadOrGenerateHostKey(keyPath: string): Promise<Buffer> {
  if (existsSync(keyPath)) {
    logger.info({ keyPath }, 'Loading existing SSH host key');
    return fs.readFile(keyPath);
  }
  return generateHostKey(keyPath);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract a project ID from a directory name.
 * Supports patterns like "6384578-ESAI-SomeSiteName" or just returns
 * the directory name as-is if it doesn't match the convention.
 */
function extractProjectId(dirName: string): string {
  const match = dirName.match(PROJECT_ID_PATTERN);
  return match ? dirName : dirName;
}

/**
 * Ensure a directory exists (sync, for use in SFTP handlers).
 */
function ensureDirSync(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

// ── FileReceiver ─────────────────────────────────────────────────────────────

/**
 * Unified file receiver that supports both local SFTP server and folder watching.
 * Emits `file-received` events for both modes with identical payloads.
 */
export class FileReceiver extends EventEmitter {
  private config: FTPConfig;
  private serverConfig: SFTPServerConfig;
  private watchDir: string;
  private mode: 'sftp' | 'folder';

  private sftpServer: ssh2.Server | null = null;
  private folderWatchers: Map<string, FSWatcher> = new Map();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private knownFiles: Set<string> = new Set();
  private running = false;

  constructor(config: FTPConfig) {
    super();
    this.config = config;
    this.serverConfig = { ...DEFAULTS, ...config.server };
    this.watchDir = path.resolve(config.watch_directory || './incoming');
    this.mode = config.watch_mode || 'folder';
  }

  /**
   * Create a FileReceiver from the full AppConfig.
   */
  static fromAppConfig(appConfig: AppConfig): FileReceiver {
    return new FileReceiver(appConfig.ftp);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Start the file receiver in the configured mode.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('FileReceiver is already running');
      return;
    }

    // Ensure the incoming directory exists
    ensureDirSync(this.watchDir);
    logger.info({ watchDir: this.watchDir, mode: this.mode }, 'Starting FileReceiver');

    if (this.mode === 'sftp') {
      await this.startSFTPServer();
    } else {
      await this.startFolderWatch();
    }

    this.running = true;
    this.emit('started', this.mode);
  }

  /**
   * Stop the file receiver and clean up resources.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    logger.info('Stopping FileReceiver...');

    if (this.sftpServer) {
      await new Promise<void>((resolve) => {
        this.sftpServer!.close(() => resolve());
      });
      this.sftpServer = null;
    }

    for (const [dir, watcher] of this.folderWatchers) {
      watcher.close();
      logger.debug({ dir }, 'Closed folder watcher');
    }
    this.folderWatchers.clear();

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.running = false;
    this.knownFiles.clear();
    this.emit('stopped');
    logger.info('FileReceiver stopped');
  }

  // ── SFTP Server Mode ────────────────────────────────────────────────────

  /**
   * Start the local SFTP server.
   */
  private async startSFTPServer(): Promise<void> {
    const hostKey = await loadOrGenerateHostKey(
      path.resolve(this.serverConfig.host_key_path)
    );

    this.sftpServer = new ssh2.Server(
      { hostKeys: [hostKey] },
      (client: ssh2.Connection) => {
        this.handleClient(client);
      }
    );

    return new Promise<void>((resolve, reject) => {
      this.sftpServer!.on('error', (err: Error) => {
        logger.error({ err }, 'SFTP server error');
        this.emit('error', err);
        reject(err);
      });

      this.sftpServer!.listen(this.serverConfig.port, '0.0.0.0', () => {
        logger.info(
          { port: this.serverConfig.port },
          `SFTP server listening on port ${this.serverConfig.port}`
        );
        resolve();
      });
    });
  }

  /**
   * Handle a new SSH client connection.
   */
  private handleClient(client: ssh2.Connection): void {
    let authenticatedUser = 'unknown';

    client.on('authentication', (ctx: ssh2.AuthContext) => {
      const { method, username } = ctx;

      if (
        method === 'password' &&
        username === this.serverConfig.username &&
        (ctx as ssh2.PasswordAuthContext).password === this.serverConfig.password
      ) {
        authenticatedUser = username;
        logger.info({ username, method }, 'Client authenticated');
        this.emit('connection', {
          username,
          ip: (client as any)._sock?.remoteAddress || 'unknown',
        });
        ctx.accept();
      } else if (method === 'none') {
        // Client is probing for supported methods
        ctx.reject(['password']);
      } else {
        logger.warn({ username, method }, 'Authentication failed');
        ctx.reject(['password']);
      }
    });

    client.on('ready', () => {
      logger.info({ user: authenticatedUser }, 'Client session ready');
      client.on('session', (accept: ssh2.AcceptConnection<ssh2.Session>, reject: ssh2.RejectConnection) => {
        const session = accept();
        this.handleSession(session, authenticatedUser);
      });
    });

    client.on('error', (err: Error) => {
      logger.error({ err }, 'Client connection error');
    });

    client.on('close', () => {
      logger.info({ user: authenticatedUser }, 'Client disconnected');
    });
  }

  /**
   * Handle an SSH session — we only care about SFTP subsystem requests.
   */
  private handleSession(session: ssh2.Session, username: string): void {
    session.on('sftp', (accept: ssh2.AcceptSftpConnection, reject: ssh2.RejectConnection) => {
      logger.info({ username }, 'SFTP subsystem requested');
      const sftpStream = accept();
      this.handleSFTPStream(sftpStream, username);
    });
  }

  /**
   * Handle SFTP protocol operations on the stream.
   *
   * We support a minimal set of operations needed for file uploads:
   * - OPEN / WRITE / CLOSE (uploading files)
   * - OPENDIR / READDIR / CLOSE (listing directories)
   * - STAT / LSTAT (file info)
   * - MKDIR (creating project directories)
   * - REALPATH (resolving paths)
   */
  private handleSFTPStream(sftp: ssh2.SFTPWrapper, username: string): void {
    const openHandles = new Map<number, { path: string; fd: number | null; flags: number }>();
    const openDirHandles = new Map<number, { path: string; read: boolean }>();
    let handleCounter = 0;

    const resolvePath = (reqPath: string): string => {
      // Normalize: strip leading slashes, resolve relative to watchDir
      const cleaned = reqPath.replace(/^\/+/, '');
      return path.join(this.watchDir, cleaned);
    };

    const EMPTY_ATTRS: ssh2.Attributes = { mode: 0, size: 0, uid: 0, gid: 0, atime: 0, mtime: 0 };

    // REALPATH — resolve a path to its canonical form
    sftp.on('REALPATH', (reqId: number, reqPath: string) => {
      logger.debug({ reqPath }, 'REALPATH');
      if (reqPath === '.' || reqPath === '/' || reqPath === '') {
        sftp.name(reqId, [{ filename: '/', longname: '/', attrs: EMPTY_ATTRS }]);
      } else {
        const resolved = '/' + reqPath.replace(/^\/+/, '');
        sftp.name(reqId, [{ filename: resolved, longname: resolved, attrs: EMPTY_ATTRS }]);
      }
    });

    // STAT / LSTAT — return file attributes
    const handleStat = (reqId: number, reqPath: string) => {
      const localPath = resolvePath(reqPath);
      try {
        const fsStats = statSync(localPath);
        const attrs: ssh2.Attributes = {
          mode: fsStats.isDirectory() ? 0o40755 : 0o100644,
          size: fsStats.size,
          uid: process.getuid?.() || 0,
          gid: process.getgid?.() || 0,
          atime: Math.floor(fsStats.atimeMs / 1000),
          mtime: Math.floor(fsStats.mtimeMs / 1000),
        };
        sftp.attrs(reqId, attrs);
      } catch {
        sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.NO_SUCH_FILE);
      }
    };

    sftp.on('STAT', (reqId: number, reqPath: string) => {
      logger.debug({ reqPath }, 'STAT');
      handleStat(reqId, reqPath);
    });

    sftp.on('LSTAT', (reqId: number, reqPath: string) => {
      logger.debug({ reqPath }, 'LSTAT');
      handleStat(reqId, reqPath);
    });

    // MKDIR — create a directory
    sftp.on('MKDIR', (reqId: number, reqPath: string, _attrs: ssh2.Attributes) => {
      const localPath = resolvePath(reqPath);
      logger.info({ reqPath, localPath }, 'MKDIR');
      try {
        ensureDirSync(localPath);
        sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.OK);
      } catch (err: any) {
        logger.error({ err, reqPath }, 'MKDIR failed');
        sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.FAILURE);
      }
    });

    // OPENDIR — open a directory for reading
    sftp.on('OPENDIR', (reqId: number, reqPath: string) => {
      const localPath = resolvePath(reqPath);
      logger.debug({ reqPath, localPath }, 'OPENDIR');
      if (!existsSync(localPath)) {
        sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.NO_SUCH_FILE);
        return;
      }
      const handle = handleCounter++;
      openDirHandles.set(handle, { path: localPath, read: false });
      const buf = Buffer.alloc(4);
      buf.writeUInt32BE(handle, 0);
      sftp.handle(reqId, buf);
    });

    // READDIR — read directory entries
    sftp.on('READDIR', (reqId: number, rawHandle: Buffer) => {
      const handle = rawHandle.readUInt32BE(0);
      const dirInfo = openDirHandles.get(handle);
      if (!dirInfo) {
        sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.FAILURE);
        return;
      }

      if (dirInfo.read) {
        // Already returned all entries
        sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.EOF);
        return;
      }

      dirInfo.read = true;
      try {
        const dirEntries = readdirSync(dirInfo.path, { withFileTypes: true });
        const names: ssh2.FileEntry[] = dirEntries.map((entry) => ({
          filename: entry.name,
          longname: entry.name,
          attrs: {
            mode: entry.isDirectory() ? 0o40755 : 0o100644,
            size: 0,
            uid: 0,
            gid: 0,
            atime: 0,
            mtime: 0,
          },
        }));
        sftp.name(reqId, names);
      } catch {
        sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.FAILURE);
      }
    });

    // OPEN — open a file for reading or writing
    sftp.on('OPEN', (reqId: number, reqPath: string, flags: number, _attrs: ssh2.Attributes) => {
      const localPath = resolvePath(reqPath);
      logger.info({ reqPath, localPath, flags, username }, 'OPEN');

      // Ensure parent directory exists
      ensureDirSync(path.dirname(localPath));

      try {
        const WRITE = ssh2.utils.sftp.OPEN_MODE.WRITE;
        const CREATE = ssh2.utils.sftp.OPEN_MODE.CREAT;
        const TRUNC = ssh2.utils.sftp.OPEN_MODE.TRUNC;

        let fsFlags = 'r';
        if (flags & WRITE) {
          fsFlags = (flags & TRUNC) ? 'w' : (flags & CREATE) ? 'wx' : 'r+';
          // Fall back to 'w' if 'wx' would fail because file exists
          if (fsFlags === 'wx' && existsSync(localPath)) {
            fsFlags = 'w';
          }
        }

        const fd = openSync(localPath, fsFlags);
        const handle = handleCounter++;
        openHandles.set(handle, { path: localPath, fd, flags });
        const buf = Buffer.alloc(4);
        buf.writeUInt32BE(handle, 0);
        sftp.handle(reqId, buf);
      } catch (err: any) {
        logger.error({ err, reqPath }, 'OPEN failed');
        sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.FAILURE);
      }
    });

    // WRITE — write data to an open file handle
    sftp.on('WRITE', (reqId: number, rawHandle: Buffer, offset: number, data: Buffer) => {
      const handle = rawHandle.readUInt32BE(0);
      const fileInfo = openHandles.get(handle);
      if (!fileInfo || fileInfo.fd === null) {
        sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.FAILURE);
        return;
      }

      try {
        writeSync(fileInfo.fd, data, 0, data.length, offset);
        sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.OK);
      } catch (err: any) {
        logger.error({ err, path: fileInfo.path }, 'WRITE failed');
        sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.FAILURE);
      }
    });

    // READ — read data from an open file handle
    sftp.on('READ', (reqId: number, rawHandle: Buffer, offset: number, length: number) => {
      const handle = rawHandle.readUInt32BE(0);
      const fileInfo = openHandles.get(handle);
      if (!fileInfo || fileInfo.fd === null) {
        sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.FAILURE);
        return;
      }

      try {
        const buf = Buffer.alloc(length);
        const bytesRead = readSync(fileInfo.fd, buf, 0, length, offset);
        if (bytesRead === 0) {
          sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.EOF);
        } else {
          sftp.data(reqId, buf.subarray(0, bytesRead));
        }
      } catch (err: any) {
        logger.error({ err, path: fileInfo.path }, 'READ failed');
        sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.FAILURE);
      }
    });

    // CLOSE — close a file or directory handle
    sftp.on('CLOSE', (reqId: number, rawHandle: Buffer) => {
      const handle = rawHandle.readUInt32BE(0);

      // Check if it's a directory handle
      if (openDirHandles.has(handle)) {
        openDirHandles.delete(handle);
        sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.OK);
        return;
      }

      // File handle
      const fileInfo = openHandles.get(handle);
      if (!fileInfo) {
        sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.FAILURE);
        return;
      }

      try {
        if (fileInfo.fd !== null) {
          closeSync(fileInfo.fd);
        }
        openHandles.delete(handle);
        sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.OK);

        // Check if this was a write operation on a PDF
        const WRITE = ssh2.utils.sftp.OPEN_MODE.WRITE;
        if (fileInfo.flags & WRITE) {
          logger.info(
            { path: fileInfo.path, username },
            'File upload complete'
          );
          this.onFileUploaded(fileInfo.path);
        }
      } catch (err: any) {
        logger.error({ err }, 'CLOSE failed');
        sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.FAILURE);
      }
    });

    // REMOVE — delete a file
    sftp.on('REMOVE', (reqId: number, reqPath: string) => {
      const localPath = resolvePath(reqPath);
      logger.info({ reqPath, localPath }, 'REMOVE');
      try {
        unlinkSync(localPath);
        sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.OK);
      } catch {
        sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.NO_SUCH_FILE);
      }
    });

    // FSTAT — stat an open file handle
    sftp.on('FSTAT', (reqId: number, rawHandle: Buffer) => {
      const handle = rawHandle.readUInt32BE(0);
      const fileInfo = openHandles.get(handle);
      if (!fileInfo || fileInfo.fd === null) {
        sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.FAILURE);
        return;
      }
      try {
        const fsStats = fstatSync(fileInfo.fd);
        const attrs: ssh2.Attributes = {
          mode: fsStats.isDirectory() ? 0o40755 : 0o100644,
          size: fsStats.size,
          uid: process.getuid?.() || 0,
          gid: process.getgid?.() || 0,
          atime: Math.floor(fsStats.atimeMs / 1000),
          mtime: Math.floor(fsStats.mtimeMs / 1000),
        };
        sftp.attrs(reqId, attrs);
      } catch {
        sftp.status(reqId, ssh2.utils.sftp.STATUS_CODE.FAILURE);
      }
    });
  }

  /**
   * Called when a file is fully uploaded via SFTP.
   * Extracts project info and emits the `file-received` event.
   */
  private onFileUploaded(filePath: string): void {
    const filename = path.basename(filePath);

    // Accept PDF, Visio, Office docs, and image files
    const ext = path.extname(filename).toLowerCase();
    const accepted = ['.pdf', '.vsd', '.vsdx', '.doc', '.docx', '.xls', '.xlsx', '.jpg', '.jpeg', '.png', '.tif', '.tiff'];
    if (!accepted.includes(ext)) {
      logger.debug({ filename, ext }, 'Ignoring unsupported file type');
      return;
    }

    // The directory structure is incoming/{project-id}/filename.pdf
    const relativePath = path.relative(this.watchDir, filePath);
    const parts = relativePath.split(path.sep);
    const projectDir = parts.length >= 2 ? parts[0] : 'unknown';
    const projectId = extractProjectId(projectDir);

    const event: FileReceivedEvent = {
      projectId,
      filename,
      localPath: filePath,
      receivedAt: new Date(),
    };

    logger.info(
      { projectId, filename },
      `PDF received: ${filename} for project ${projectId}`
    );
    this.emit('file-received', event);
  }

  // ── Folder Watch Mode ──────────────────────────────────────────────────

  /**
   * Start watching the local incoming directory for new files.
   * Uses polling to detect new files in project subdirectories.
   */
  private async startFolderWatch(): Promise<void> {
    logger.info({ watchDir: this.watchDir }, 'Starting folder watch mode');

    // Do an initial scan to build the known-files set
    await this.scanExistingFiles();

    // Poll for new files at the configured interval
    const intervalMs = (this.config.poll_interval_seconds || 5) * 1000;
    this.pollInterval = setInterval(() => {
      this.pollForNewFiles().catch((err) => {
        logger.error({ err }, 'Error during folder poll');
      });
    }, intervalMs);

    logger.info(
      { intervalMs },
      `Folder watcher polling every ${intervalMs / 1000}s`
    );
  }

  /**
   * Scan all existing files and add them to the known set (no events emitted).
   */
  private async scanExistingFiles(): Promise<void> {
    if (!existsSync(this.watchDir)) return;

    const entries = await fs.readdir(this.watchDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectDir = path.join(this.watchDir, entry.name);
      const files = await fs.readdir(projectDir);
      for (const file of files) {
        this.knownFiles.add(path.join(projectDir, file));
      }
    }

    logger.info(
      { count: this.knownFiles.size },
      'Initial scan complete — tracking existing files'
    );
  }

  /**
   * Poll the incoming directory tree for files not yet in the known set.
   */
  private async pollForNewFiles(): Promise<void> {
    if (!existsSync(this.watchDir)) return;

    const entries = await fs.readdir(this.watchDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const projectDir = path.join(this.watchDir, entry.name);
      let files: string[];
      try {
        files = await fs.readdir(projectDir);
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = path.join(projectDir, file);

        if (this.knownFiles.has(filePath)) continue;
        this.knownFiles.add(filePath);

        // Process supported file types (PDF, Visio, Office docs, images)
        const fileExt = path.extname(file).toLowerCase();
        const supportedExts = ['.pdf', '.vsd', '.vsdx', '.doc', '.docx', '.xls', '.xlsx', '.jpg', '.jpeg', '.png', '.tif', '.tiff'];
        if (!supportedExts.includes(fileExt)) {
          logger.debug({ file, fileExt }, 'Skipping unsupported file type in watch directory');
          continue;
        }

        // Brief delay to let writes finish (file might still be copying)
        await this.waitForFileStable(filePath);

        const projectId = extractProjectId(entry.name);
        const event: FileReceivedEvent = {
          projectId,
          filename: file,
          localPath: filePath,
          receivedAt: new Date(),
        };

        logger.info(
          { projectId, filename: file },
          `New PDF detected: ${file} for project ${projectId}`
        );
        this.emit('file-received', event);
      }
    }
  }

  /**
   * Wait until a file's size stabilizes (no more writes in progress).
   * Checks every 500ms up to 5 times.
   */
  private async waitForFileStable(filePath: string, maxChecks = 5): Promise<void> {
    let lastSize = -1;
    for (let i = 0; i < maxChecks; i++) {
      try {
        const stat = await fs.stat(filePath);
        if (stat.size === lastSize && stat.size > 0) return;
        lastSize = stat.size;
      } catch {
        return; // File removed, nothing to do
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  // ── Status ─────────────────────────────────────────────────────────────

  /**
   * Get the current status of the receiver.
   */
  getStatus(): { running: boolean; mode: string; watchDir: string; port?: number } {
    return {
      running: this.running,
      mode: this.mode,
      watchDir: this.watchDir,
      ...(this.mode === 'sftp' ? { port: this.serverConfig.port } : {}),
    };
  }
}

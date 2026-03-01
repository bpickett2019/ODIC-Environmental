/**
 * FTP/SFTP Pull Client — connects to ODIC's remote FTP server to pull project folders.
 *
 * Supports both FTP (via basic-ftp) and SFTP (via ssh2-sftp-client).
 * Emits events for folder detection, file downloads, and errors.
 * Tracks already-pulled files via a JSON manifest to avoid re-downloads.
 *
 * Usage:
 *   const client = new FTPPullClient(config);
 *   client.on('folder-detected', (folder) => { ... });
 *   client.on('file-pulled', (info) => { ... });
 *   await client.connect();
 *   await client.pullFolder('/projects/6384578-ESAI-Site', './downloads/6384578-ESAI-Site');
 */

import { EventEmitter } from 'events';
import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import pino from 'pino';
import { Client as FTPClient } from 'basic-ftp';
import SFTPClient from 'ssh2-sftp-client';

const logger = pino({ name: 'FTPPullClient', level: process.env.LOG_LEVEL || 'info' });

// ── Types ────────────────────────────────────────────────────────────────────

export interface RemoteFTPConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  password: string;
  protocol: 'ftp' | 'sftp';
  watch_directory: string;
  poll_interval_seconds: number;
}

export interface FolderDetectedEvent {
  remotePath: string;
  folderName: string;
  detectedAt: Date;
}

export interface FilePulledEvent {
  remotePath: string;
  localPath: string;
  filename: string;
  size: number;
  pulledAt: Date;
}

export interface FTPPullClientEvents {
  'folder-detected': (event: FolderDetectedEvent) => void;
  'file-pulled': (event: FilePulledEvent) => void;
  'error': (error: Error) => void;
}

export declare interface FTPPullClient {
  on<E extends keyof FTPPullClientEvents>(event: E, listener: FTPPullClientEvents[E]): this;
  emit<E extends keyof FTPPullClientEvents>(event: E, ...args: Parameters<FTPPullClientEvents[E]>): boolean;
  off<E extends keyof FTPPullClientEvents>(event: E, listener: FTPPullClientEvents[E]): this;
}

interface PulledFilesManifest {
  pulledFiles: string[];
  lastUpdated: string;
}

// ── FTPPullClient ────────────────────────────────────────────────────────────

export class FTPPullClient extends EventEmitter {
  private config: RemoteFTPConfig;
  private ftpClient: FTPClient | null = null;
  private sftpClient: SFTPClient | null = null;
  private connected = false;
  private polling = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pulledFiles: Set<string> = new Set();
  private knownFolders: Set<string> = new Set();
  private manifestPath: string;

  constructor(config: RemoteFTPConfig, manifestDir?: string) {
    super();
    this.config = config;
    const dir = manifestDir || './data';
    this.manifestPath = path.resolve(dir, 'ftp-pull-manifest.json');
  }

  // ── Connection ──────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.connected) {
      logger.warn('Already connected');
      return;
    }

    await this.loadManifest();

    if (this.config.protocol === 'sftp') {
      await this.connectSFTP();
    } else {
      await this.connectFTP();
    }

    this.connected = true;
    logger.info(
      { host: this.config.host, port: this.config.port, protocol: this.config.protocol },
      'Connected to remote FTP server'
    );
  }

  private async connectFTP(): Promise<void> {
    this.ftpClient = new FTPClient();
    this.ftpClient.ftp.verbose = false;

    await this.ftpClient.access({
      host: this.config.host,
      port: this.config.port,
      user: this.config.username,
      password: this.config.password,
      secure: false,
    });
  }

  private async connectSFTP(): Promise<void> {
    this.sftpClient = new SFTPClient();

    await this.sftpClient.connect({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password,
    });
  }

  async disconnect(): Promise<void> {
    this.stopPolling();

    if (this.ftpClient) {
      this.ftpClient.close();
      this.ftpClient = null;
    }
    if (this.sftpClient) {
      await this.sftpClient.end();
      this.sftpClient = null;
    }

    this.connected = false;
    logger.info('Disconnected from remote FTP server');
  }

  // ── Listing ─────────────────────────────────────────────────────────────

  async listFolders(remotePath?: string): Promise<{ name: string; path: string }[]> {
    this.ensureConnected();
    const target = remotePath || this.config.watch_directory;
    const folders: { name: string; path: string }[] = [];

    if (this.config.protocol === 'sftp') {
      const list = await this.sftpClient!.list(target);
      for (const entry of list) {
        if (entry.type === 'd' && !entry.name.startsWith('.')) {
          folders.push({ name: entry.name, path: `${target}/${entry.name}` });
        }
      }
    } else {
      await this.ftpClient!.cd(target);
      const list = await this.ftpClient!.list();
      for (const entry of list) {
        if (entry.isDirectory && !entry.name.startsWith('.')) {
          folders.push({ name: entry.name, path: `${target}/${entry.name}` });
        }
      }
    }

    return folders;
  }

  async listFiles(remotePath: string): Promise<{ name: string; size: number; path: string }[]> {
    this.ensureConnected();
    const files: { name: string; size: number; path: string }[] = [];

    if (this.config.protocol === 'sftp') {
      const list = await this.sftpClient!.list(remotePath);
      for (const entry of list) {
        if (entry.type !== 'd' && !entry.name.startsWith('.')) {
          files.push({ name: entry.name, size: entry.size, path: `${remotePath}/${entry.name}` });
        }
      }
    } else {
      await this.ftpClient!.cd(remotePath);
      const list = await this.ftpClient!.list();
      for (const entry of list) {
        if (!entry.isDirectory && !entry.name.startsWith('.')) {
          files.push({ name: entry.name, size: entry.size, path: `${remotePath}/${entry.name}` });
        }
      }
    }

    return files;
  }

  // ── Pull Operations ─────────────────────────────────────────────────────

  async pullFile(remotePath: string, localPath: string): Promise<FilePulledEvent> {
    this.ensureConnected();

    // Ensure local directory exists
    const localDir = path.dirname(localPath);
    if (!existsSync(localDir)) {
      mkdirSync(localDir, { recursive: true });
    }

    if (this.config.protocol === 'sftp') {
      await this.sftpClient!.fastGet(remotePath, localPath);
    } else {
      await this.ftpClient!.downloadTo(localPath, remotePath);
    }

    const stat = await fs.stat(localPath);
    const event: FilePulledEvent = {
      remotePath,
      localPath,
      filename: path.basename(remotePath),
      size: stat.size,
      pulledAt: new Date(),
    };

    this.pulledFiles.add(remotePath);
    await this.saveManifest();

    logger.info({ remotePath, localPath, size: stat.size }, 'File pulled');
    this.emit('file-pulled', event);

    return event;
  }

  async pullFolder(
    remotePath: string,
    localPath: string
  ): Promise<{ pulled: FilePulledEvent[]; skipped: number }> {
    this.ensureConnected();

    const files = await this.listFiles(remotePath);
    const pulled: FilePulledEvent[] = [];
    let skipped = 0;

    for (const file of files) {
      if (this.pulledFiles.has(file.path)) {
        skipped++;
        logger.debug({ remotePath: file.path }, 'Already pulled, skipping');
        continue;
      }

      try {
        const localFilePath = path.join(localPath, file.name);
        const event = await this.pullFile(file.path, localFilePath);
        pulled.push(event);
      } catch (err) {
        logger.error({ err, remotePath: file.path }, 'Failed to pull file');
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }

    return { pulled, skipped };
  }

  // ── Polling ─────────────────────────────────────────────────────────────

  startPolling(callback?: (folder: FolderDetectedEvent) => void): void {
    if (this.polling) {
      logger.warn('Already polling');
      return;
    }

    if (callback) {
      this.on('folder-detected', callback);
    }

    const intervalMs = (this.config.poll_interval_seconds || 300) * 1000;
    this.polling = true;

    logger.info(
      { intervalMs, watchDirectory: this.config.watch_directory },
      'Started polling remote FTP for new folders'
    );

    // Immediately run once, then start the interval
    this.pollOnce().catch((err) => {
      logger.error({ err }, 'Error during initial poll');
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });

    this.pollTimer = setInterval(() => {
      this.pollOnce().catch((err) => {
        logger.error({ err }, 'Error during poll');
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      });
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.polling = false;
    logger.info('Stopped polling');
  }

  private async pollOnce(): Promise<void> {
    if (!this.connected) return;

    try {
      const folders = await this.listFolders();

      for (const folder of folders) {
        if (!this.knownFolders.has(folder.path)) {
          this.knownFolders.add(folder.path);

          const event: FolderDetectedEvent = {
            remotePath: folder.path,
            folderName: folder.name,
            detectedAt: new Date(),
          };

          logger.info({ folder: folder.name, path: folder.path }, 'New folder detected');
          this.emit('folder-detected', event);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Poll cycle failed');
      this.emit('error', err instanceof Error ? err : new Error(String(err)));

      // Try to reconnect on failure
      this.connected = false;
      try {
        await this.connect();
        logger.info('Reconnected after poll failure');
      } catch (reconnectErr) {
        logger.error({ err: reconnectErr }, 'Reconnection failed');
      }
    }
  }

  // ── Status ──────────────────────────────────────────────────────────────

  getStatus(): {
    connected: boolean;
    polling: boolean;
    protocol: string;
    host: string;
    port: number;
    watchDirectory: string;
    pollIntervalSeconds: number;
    pulledFileCount: number;
    knownFolderCount: number;
  } {
    return {
      connected: this.connected,
      polling: this.polling,
      protocol: this.config.protocol,
      host: this.config.host,
      port: this.config.port,
      watchDirectory: this.config.watch_directory,
      pollIntervalSeconds: this.config.poll_interval_seconds,
      pulledFileCount: this.pulledFiles.size,
      knownFolderCount: this.knownFolders.size,
    };
  }

  // ── Manifest Persistence ────────────────────────────────────────────────

  private async loadManifest(): Promise<void> {
    try {
      if (existsSync(this.manifestPath)) {
        const raw = await fs.readFile(this.manifestPath, 'utf-8');
        const data: PulledFilesManifest = JSON.parse(raw);
        this.pulledFiles = new Set(data.pulledFiles || []);
        logger.info({ count: this.pulledFiles.size }, 'Loaded pull manifest');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load pull manifest, starting fresh');
      this.pulledFiles = new Set();
    }
  }

  private async saveManifest(): Promise<void> {
    try {
      const dir = path.dirname(this.manifestPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const data: PulledFilesManifest = {
        pulledFiles: [...this.pulledFiles],
        lastUpdated: new Date().toISOString(),
      };
      await fs.writeFile(this.manifestPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      logger.warn({ err }, 'Failed to save pull manifest');
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error('Not connected to remote FTP server. Call connect() first.');
    }
  }
}

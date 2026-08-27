import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type ApplicationType = "create" | "delete";
export type ApplicationStatus =
  | "collecting_evidence"
  | "pending"
  | "approved"
  | "rejected";

export interface Settings {
  guildId: string;
  panelChannelId: string;
  applicationsChannelId: string;
  mainCuratorRoleId: string;
  deputyCuratorRoleId: string;
  leaderRoleId: string;
  deputyLeaderRoleId: string;
  seniorRoleId: string;
  familyRoleId: string;
  panelMessageId: string | null;
}

export interface Family {
  id: number;
  guildId: string;
  name: string;
  ownerId: string;
  nickname: string;
  rank: number;
  familyRoleId: string;
  ldRoleId: string;
  categoryId: string;
  textChannelId: string;
  voiceChannelId: string;
  status: "active";
}

export interface Application {
  id: number;
  guildId: string;
  type: ApplicationType;
  userId: string;
  targetUserId: string | null;
  nickname: string | null;
  familyName: string | null;
  colorHex: string | null;
  rank: number | null;
  evidenceUrls: string[];
  familyId: number | null;
  reason: string | null;
  status: ApplicationStatus;
  tempChannelId: string | null;
  reviewMessageId: string | null;
}

export interface Transfer {
  id: number;
  guildId: string;
  familyId: number;
  fromUserId: string;
  targetUserId: string;
  status: "pending" | "approved" | "rejected";
  reason: string | null;
  reviewMessageId: string | null;
}

const DEFAULT_SQLITE_PATH = "./data/families.sqlite";

function jsonParse(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

export class BotDatabase {
  private readonly db: Database.Database;

  public constructor(filePath = process.env["SQLITE_PATH"] || DEFAULT_SQLITE_PATH) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        guild_id TEXT PRIMARY KEY,
        panel_channel_id TEXT NOT NULL,
        applications_channel_id TEXT NOT NULL,
        main_curator_role_id TEXT NOT NULL,
        deputy_curator_role_id TEXT NOT NULL,
        leader_role_id TEXT NOT NULL,
        deputy_leader_role_id TEXT NOT NULL,
        senior_role_id TEXT NOT NULL,
        family_role_id TEXT NOT NULL,
        panel_message_id TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS families (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        nickname TEXT NOT NULL,
        rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 10),
        family_role_id TEXT NOT NULL,
        ld_role_id TEXT NOT NULL,
        category_id TEXT NOT NULL,
        text_channel_id TEXT NOT NULL,
        voice_channel_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (guild_id, name)
      );

      CREATE TABLE IF NOT EXISTS applications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('create', 'delete')),
        user_id TEXT NOT NULL,
        target_user_id TEXT,
        nickname TEXT,
        family_name TEXT,
        color_hex TEXT,
        rank INTEGER,
        evidence_urls TEXT NOT NULL DEFAULT '[]',
        family_id INTEGER,
        reason TEXT,
        status TEXT NOT NULL,
        temp_channel_id TEXT,
        review_message_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reviewed_by TEXT,
        reviewed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS transfers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        family_id INTEGER NOT NULL,
        from_user_id TEXT NOT NULL,
        target_user_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        reason TEXT,
        review_message_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reviewed_by TEXT,
        reviewed_at TEXT,
        FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_applications_status
        ON applications (guild_id, status);
      CREATE INDEX IF NOT EXISTS idx_transfers_status
        ON transfers (guild_id, status);
    `);
  }

  public getSettings(guildId: string): Settings | null {
    const row = this.db.prepare("SELECT * FROM settings WHERE guild_id = ?").get(guildId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      guildId: String(row["guild_id"]),
      panelChannelId: String(row["panel_channel_id"]),
      applicationsChannelId: String(row["applications_channel_id"]),
      mainCuratorRoleId: String(row["main_curator_role_id"]),
      deputyCuratorRoleId: String(row["deputy_curator_role_id"]),
      leaderRoleId: String(row["leader_role_id"]),
      deputyLeaderRoleId: String(row["deputy_leader_role_id"]),
      seniorRoleId: String(row["senior_role_id"]),
      familyRoleId: String(row["family_role_id"]),
      panelMessageId: row["panel_message_id"] ? String(row["panel_message_id"]) : null,
    };
  }

  public saveSettings(settings: Omit<Settings, "panelMessageId"> & { panelMessageId?: string | null }): void {
    this.db
      .prepare(`
        INSERT INTO settings (
          guild_id, panel_channel_id, applications_channel_id,
          main_curator_role_id, deputy_curator_role_id, leader_role_id,
          deputy_leader_role_id, senior_role_id, family_role_id, panel_message_id
        ) VALUES (
          @guildId, @panelChannelId, @applicationsChannelId,
          @mainCuratorRoleId, @deputyCuratorRoleId, @leaderRoleId,
          @deputyLeaderRoleId, @seniorRoleId, @familyRoleId, @panelMessageId
        )
        ON CONFLICT(guild_id) DO UPDATE SET
          panel_channel_id = excluded.panel_channel_id,
          applications_channel_id = excluded.applications_channel_id,
          main_curator_role_id = excluded.main_curator_role_id,
          deputy_curator_role_id = excluded.deputy_curator_role_id,
          leader_role_id = excluded.leader_role_id,
          deputy_leader_role_id = excluded.deputy_leader_role_id,
          senior_role_id = excluded.senior_role_id,
          family_role_id = excluded.family_role_id,
          panel_message_id = COALESCE(excluded.panel_message_id, settings.panel_message_id),
          updated_at = CURRENT_TIMESTAMP
      `)
      .run({ ...settings, panelMessageId: settings.panelMessageId ?? null });
  }

  public setPanelMessageId(guildId: string, panelMessageId: string): void {
    this.db
      .prepare("UPDATE settings SET panel_message_id = ?, updated_at = CURRENT_TIMESTAMP WHERE guild_id = ?")
      .run(panelMessageId, guildId);
  }

  public createApplication(input: {
    guildId: string;
    type: ApplicationType;
    userId: string;
    nickname?: string;
    familyName?: string;
    colorHex?: string;
    rank?: number;
    reason?: string;
    familyId?: number;
    tempChannelId?: string;
  }): number {
    const result = this.db
      .prepare(`
        INSERT INTO applications (
          guild_id, type, user_id, nickname, family_name, color_hex, rank,
          family_id, reason, status, temp_channel_id
        ) VALUES (
          @guildId, @type, @userId, @nickname, @familyName, @colorHex, @rank,
          @familyId, @reason, @status, @tempChannelId
        )
      `)
      .run({
        ...input,
        nickname: input.nickname ?? null,
        familyName: input.familyName ?? null,
        colorHex: input.colorHex ?? null,
        rank: input.rank ?? null,
        reason: input.reason ?? null,
        familyId: input.familyId ?? null,
        tempChannelId: input.tempChannelId ?? null,
        status: input.type === "create" ? "collecting_evidence" : "pending",
      });
    return Number(result.lastInsertRowid);
  }

  public getApplication(id: number): Application | null {
    const row = this.db.prepare("SELECT * FROM applications WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapApplication(row) : null;
  }

  private mapApplication(row: Record<string, unknown>): Application {
    return {
      id: Number(row["id"]),
      guildId: String(row["guild_id"]),
      type: row["type"] as ApplicationType,
      userId: String(row["user_id"]),
      targetUserId: row["target_user_id"] ? String(row["target_user_id"]) : null,
      nickname: row["nickname"] ? String(row["nickname"]) : null,
      familyName: row["family_name"] ? String(row["family_name"]) : null,
      colorHex: row["color_hex"] ? String(row["color_hex"]) : null,
      rank: row["rank"] === null || row["rank"] === undefined ? null : Number(row["rank"]),
      evidenceUrls: jsonParse(row["evidence_urls"] ? String(row["evidence_urls"]) : null),
      familyId: row["family_id"] === null || row["family_id"] === undefined ? null : Number(row["family_id"]),
      reason: row["reason"] ? String(row["reason"]) : null,
      status: row["status"] as ApplicationStatus,
      tempChannelId: row["temp_channel_id"] ? String(row["temp_channel_id"]) : null,
      reviewMessageId: row["review_message_id"] ? String(row["review_message_id"]) : null,
    };
  }

  public updateApplicationEvidence(id: number, evidenceUrls: string[], reviewMessageId: string): void {
    this.db
      .prepare(`
        UPDATE applications SET
          evidence_urls = ?, status = 'pending', review_message_id = ?, temp_channel_id = NULL
        WHERE id = ? AND status = 'collecting_evidence'
      `)
      .run(JSON.stringify(evidenceUrls), reviewMessageId, id);
  }

  public updateEvidenceUrls(id: number, evidenceUrls: string[]): void {
    this.db
      .prepare(`
        UPDATE applications SET evidence_urls = ?
        WHERE id = ? AND status = 'collecting_evidence'
      `)
      .run(JSON.stringify(evidenceUrls), id);
  }

  public getApplicationByTempChannel(channelId: string): Application | null {
    const row = this.db.prepare("SELECT * FROM applications WHERE temp_channel_id = ?").get(channelId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapApplication(row) : null;
  }

  public setApplicationReviewMessage(id: number, reviewMessageId: string): void {
    this.db.prepare("UPDATE applications SET review_message_id = ? WHERE id = ?").run(reviewMessageId, id);
  }

  public setApplicationStatus(id: number, status: "approved" | "rejected", reviewerId: string, reason?: string): void {
    this.db
      .prepare(`
        UPDATE applications SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
          reason = COALESCE(?, reason)
        WHERE id = ? AND status = 'pending'
      `)
      .run(status, reviewerId, reason ?? null, id);
  }

  public createFamily(input: Omit<Family, "id" | "status">): number {
    const result = this.db
      .prepare(`
        INSERT INTO families (
          guild_id, name, owner_id, nickname, rank, family_role_id, ld_role_id,
          category_id, text_channel_id, voice_channel_id
        ) VALUES (
          @guildId, @name, @ownerId, @nickname, @rank, @familyRoleId, @ldRoleId,
          @categoryId, @textChannelId, @voiceChannelId
        )
      `)
      .run(input);
    return Number(result.lastInsertRowid);
  }

  public getFamily(id: number): Family | null {
    return this.mapFamily(this.db.prepare("SELECT * FROM families WHERE id = ?").get(id) as Record<string, unknown> | undefined);
  }

  public getFamilyByOwner(guildId: string, ownerId: string): Family | null {
    return this.mapFamily(
      this.db
        .prepare("SELECT * FROM families WHERE guild_id = ? AND owner_id = ? AND status = 'active'")
        .get(guildId, ownerId) as Record<string, unknown> | undefined,
    );
  }

  public getFamilyByName(guildId: string, name: string): Family | null {
    return this.mapFamily(
      this.db
        .prepare("SELECT * FROM families WHERE guild_id = ? AND name = ? AND status = 'active'")
        .get(guildId, name) as Record<string, unknown> | undefined,
    );
  }

  private mapFamily(row: Record<string, unknown> | undefined): Family | null {
    if (!row) return null;
    return {
      id: Number(row["id"]),
      guildId: String(row["guild_id"]),
      name: String(row["name"]),
      ownerId: String(row["owner_id"]),
      nickname: String(row["nickname"]),
      rank: Number(row["rank"]),
      familyRoleId: String(row["family_role_id"]),
      ldRoleId: String(row["ld_role_id"]),
      categoryId: String(row["category_id"]),
      textChannelId: String(row["text_channel_id"]),
      voiceChannelId: String(row["voice_channel_id"]),
      status: "active",
    };
  }

  public updateFamilyOwner(id: number, ownerId: string): void {
    this.db
      .prepare("UPDATE families SET owner_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(ownerId, id);
  }

  public deleteFamily(id: number): void {
    this.db.prepare("DELETE FROM families WHERE id = ?").run(id);
  }

  public createTransfer(input: Omit<Transfer, "id" | "status" | "reason" | "reviewMessageId">): number {
    const result = this.db
      .prepare(`
        INSERT INTO transfers (guild_id, family_id, from_user_id, target_user_id)
        VALUES (@guildId, @familyId, @fromUserId, @targetUserId)
      `)
      .run(input);
    return Number(result.lastInsertRowid);
  }

  public getTransfer(id: number): Transfer | null {
    const row = this.db.prepare("SELECT * FROM transfers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: Number(row["id"]),
      guildId: String(row["guild_id"]),
      familyId: Number(row["family_id"]),
      fromUserId: String(row["from_user_id"]),
      targetUserId: String(row["target_user_id"]),
      status: row["status"] as Transfer["status"],
      reason: row["reason"] ? String(row["reason"]) : null,
      reviewMessageId: row["review_message_id"] ? String(row["review_message_id"]) : null,
    };
  }

  public setTransferReviewMessage(id: number, reviewMessageId: string): void {
    this.db.prepare("UPDATE transfers SET review_message_id = ? WHERE id = ?").run(reviewMessageId, id);
  }

  public setTransferStatus(id: number, status: "approved" | "rejected", reviewerId: string, reason?: string): void {
    this.db
      .prepare(`
        UPDATE transfers SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
          reason = ?
        WHERE id = ? AND status = 'pending'
      `)
      .run(status, reviewerId, reason ?? null, id);
  }

  public close(): void {
    this.db.close();
  }
}
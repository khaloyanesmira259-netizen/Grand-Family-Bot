import {
  ActionRowBuilder,
  AttachmentBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits,
  REST,
  Routes,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type Interaction,
  type Role,
  type TextChannel,
} from "discord.js";
import { logger } from "../lib/logger";
import {
  BotDatabase,
  type Application,
  type Family,
  type Settings,
} from "./database";

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;
const DISCORD_ID_PATTERN = /^\d{16,22}$/;
const SETUP_TTL_MS = 10 * 60 * 1000;
const BOT_NOTIFICATION_HEADER = "[❗️ уведомления от бота❗️]";

const FAMILY_HEARTS: ReadonlyArray<{
  emoji: string;
  rgb: readonly [number, number, number];
}> = [
  { emoji: "🖤", rgb: [0, 0, 0] },
  { emoji: "🤍", rgb: [255, 255, 255] },
  { emoji: "❤️", rgb: [255, 0, 0] },
  { emoji: "🧡", rgb: [255, 165, 0] },
  { emoji: "💛", rgb: [255, 215, 0] },
  { emoji: "💚", rgb: [46, 204, 113] },
  { emoji: "💙", rgb: [52, 152, 219] },
  { emoji: "💜", rgb: [155, 89, 182] },
  { emoji: "🤎", rgb: [139, 69, 19] },
  { emoji: "🩷", rgb: [255, 105, 180] },
  { emoji: "🩵", rgb: [93, 173, 226] },
  { emoji: "🩶", rgb: [128, 128, 128] },
];

type SetupDraft = Omit<Settings, "panelMessageId">;
type SetupStageOneDraft = Omit<SetupDraft, "deputyLeaderRoleId" | "seniorRoleId" | "familyRoleId">;

const setupDrafts = new Map<string, { expiresAt: number; draft: SetupStageOneDraft }>();

const slashCommands = [
  {
    name: "setup",
    description: "Настроить Grand Family Bot",
    name_localizations: { ru: "настройка" },
    description_localizations: { ru: "Настроить Grand Family Bot" },
  },
  {
    name: "panel",
    description: "Создать или обновить панель",
    name_localizations: { ru: "панель" },
    description_localizations: { ru: "Создать или обновить панель" },
  },
  {
    name: "actual-family-list",
    description: "Показать семьи, найденные непосредственно на сервере Discord",
    name_localizations: { ru: "актуальный-список-семей" },
    description_localizations: { ru: "Проверить категории и основные роли семей в Discord" },
  },
  {
    name: "give-points",
    description: "Выдать баллы куратору",
    name_localizations: { ru: "выдача" },
    description_localizations: { ru: "Выдать баллы куратору" },
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: "points",
        description: "Выдать указанное количество баллов",
        name_localizations: { ru: "баллы" },
        description_localizations: { ru: "Выдать указанное количество баллов" },
        options: [
          {
            type: ApplicationCommandOptionType.User,
            name: "target",
            description: "Куратор, которому выдаются баллы",
            name_localizations: { ru: "пользователь" },
            required: true,
          },
          {
            type: ApplicationCommandOptionType.Integer,
            name: "amount",
            description: "Количество баллов",
            name_localizations: { ru: "сколько" },
            required: true,
            min_value: 1,
            max_value: 25_000,
          },
        ],
      },
    ],
  },
  {
    name: "points",
    description: "Посмотреть баллы кураторов",
    name_localizations: { ru: "баллы" },
    description_localizations: { ru: "Посмотреть баллы кураторов" },
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: "balance",
        description: "Посмотреть количество баллов",
        name_localizations: { ru: "количество" },
        description_localizations: { ru: "Посмотреть количество баллов" },
        options: [
          {
            type: ApplicationCommandOptionType.User,
            name: "user",
            description: "Куратор (необязательно)",
            name_localizations: { ru: "пользователь" },
            required: false,
          },
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: "top",
        description: "Показать топ кураторов",
        name_localizations: { ru: "топ" },
        description_localizations: { ru: "Показать топ кураторов" },
        options: [
          {
            type: ApplicationCommandOptionType.Integer,
            name: "limit",
            description: "Сколько мест показать (от 1 до 25)",
            name_localizations: { ru: "количество" },
            required: false,
            min_value: 1,
            max_value: 25,
          },
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        name: "history",
        description: "Показать историю выдачи баллов",
        name_localizations: { ru: "история" },
        description_localizations: { ru: "Показать историю выдачи баллов" },
        options: [
          {
            type: ApplicationCommandOptionType.User,
            name: "user",
            description: "Показать выдачи конкретному куратору",
            name_localizations: { ru: "пользователь" },
            required: false,
          },
        ],
      },
    ],
  },
] as const;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Неизвестная ошибка Discord API.";
}

function approvalNotification(rank: number): string {
  const grantedResources = rank === 10 ? "Каналы и роль были выданы." : "Роль была выдана.";
  return `${BOT_NOTIFICATION_HEADER}\nПриветствую, ваше заявление одобрено ✅\n${grantedResources}\nПриятной игры на 15-м сервере!`;
}

function rejectionNotification(reason: string): string {
  return `${BOT_NOTIFICATION_HEADER}\nПриветствую, ваше заявление отклонено ❌\nПричина отказа: ${reason}`;
}

function cleanId(value: string): string {
  return value.trim().replace(/^<@!?(\d+)>$/, "$1");
}

function familyHeartEmoji(colorHex: string): string {
  const red = parseInt(colorHex.slice(1, 3), 16);
  const green = parseInt(colorHex.slice(3, 5), 16);
  const blue = parseInt(colorHex.slice(5, 7), 16);

  let closest = FAMILY_HEARTS[0];
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const heart of FAMILY_HEARTS) {
    const distance =
      (red - heart.rgb[0]) ** 2 +
      (green - heart.rgb[1]) ** 2 +
      (blue - heart.rgb[2]) ** 2;
    if (distance < closestDistance) {
      closest = heart;
      closestDistance = distance;
    }
  }
  return closest.emoji;
}

function setupKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

function roleIsUsable(role: Role, botMember: GuildMember): boolean {
  return !role.managed && role.position < botMember.roles.highest.position;
}

function isCurator(member: GuildMember, settings: Settings): boolean {
  return (
    member.roles.cache.has(settings.mainCuratorRoleId) ||
    member.roles.cache.has(settings.deputyCuratorRoleId)
  );
}

function rankRoleIds(family: Family, settings: Settings): string[] {
  // Выдача ранга накопительная:
  // 1–7: базовая роль семьи
  // 8: базовая роль + старший состав
  // 9: базовая роль + старший состав + заместитель лидера
  // 10: базовая роль + старший состав + заместитель лидера + лидер + ЛД
  const roleIds = [family.familyRoleId];
  if (family.rank >= 8) roleIds.push(settings.seniorRoleId);
  if (family.rank >= 9) roleIds.push(settings.deputyLeaderRoleId);
  if (family.rank >= 10) {
    roleIds.push(settings.leaderRoleId);
    roleIds.push(family.ldRoleId);
  }
  return [...new Set(roleIds)];
}

function relevantRankRoleIds(family: Family, settings: Settings): string[] {
  return [
    family.familyRoleId,
    family.ldRoleId,
    settings.seniorRoleId,
    settings.deputyLeaderRoleId,
    settings.leaderRoleId,
  ];
}

async function fetchBotMember(guild: Guild): Promise<GuildMember> {
  const me = guild.members.me ?? (await guild.members.fetchMe());
  if (!me) throw new Error("Не удалось определить участника-бота на сервере.");
  return me;
}

async function validateSetupIds(guild: Guild, draft: SetupDraft): Promise<void> {
  const panel = await guild.channels.fetch(draft.panelChannelId);
  const applications = await guild.channels.fetch(draft.applicationsChannelId);
  if (!panel || !applications) throw new Error("Канал панели или канал заявлений не найден.");
  if (!panel.isTextBased() || !("send" in panel)) {
    throw new Error("Канал панели должен быть текстовым каналом, доступным боту.");
  }
  if (!applications.isTextBased() || !("send" in applications)) {
    throw new Error("Канал заявлений должен быть текстовым каналом, доступным боту.");
  }

  const bot = await fetchBotMember(guild);
  const curatorRoleIds = [
    draft.mainCuratorRoleId,
    draft.deputyCuratorRoleId,
  ];
  const manageableRoleIds = [
    draft.leaderRoleId,
    draft.deputyLeaderRoleId,
    draft.seniorRoleId,
    draft.familyRoleId,
  ];
  for (const roleId of [...curatorRoleIds, ...manageableRoleIds]) {
    const role = await guild.roles.fetch(roleId);
    if (!role) throw new Error(`Роль с ID ${roleId} не найдена.`);
    if (manageableRoleIds.includes(roleId) && !roleIsUsable(role, bot)) {
      throw new Error(`Бот не может видеть или использовать роль «${role.name}». Поднимите роль бота выше.`);
    }
  }
}

function setupStageOneModal(): ModalBuilder {
  const fields = [
    ["panel_channel_id", "ID канала панели"],
    ["applications_channel_id", "ID канала заявлений"],
    ["main_curator_role_id", "ID роли главного куратора"],
    ["deputy_curator_role_id", "ID роли заместителя куратора"],
    ["leader_role_id", "ID роли лидера"],
  ] as const;
  const modal = new ModalBuilder()
    .setCustomId("setup:stage1")
    .setTitle("Grand Family Bot · этап 1");
  modal.addComponents(
    ...fields.map(([id, label]) =>
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(id)
          .setLabel(label)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(22),
      ),
    ),
  );
  return modal;
}

function setupStageTwoModal(): ModalBuilder {
  const fields = [
    ["deputy_leader_role_id", "ID роли заместителя"],
    ["senior_role_id", "ID роли старшего состава"],
    ["family_role_id", "ID базовой роли семьи"],
  ] as const;
  const modal = new ModalBuilder()
    .setCustomId("setup:stage2")
    .setTitle("Grand Family Bot · этап 2");
  modal.addComponents(
    ...fields.map(([id, label]) =>
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(id)
          .setLabel(label)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(22),
      ),
    ),
  );
  return modal;
}

function setupContinueComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("setup:continue")
        .setLabel("Перейти к этапу 2")
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

function applicationModal(): ModalBuilder {
  const fields = [
    ["nickname", "Ваш никнейм", "Например: Alexander"],
    ["family_name", "Название семьи", "Например: Black Family"],
    ["color_hex", "Какой цвет роль?", "Например: #8B5CF6"],
    ["rank", "Ранг 10", "Введите ровно 10"],
  ] as const;
  const modal = new ModalBuilder()
    .setCustomId("application:create")
    .setTitle("Заявление на получение роли лидера");
  modal.addComponents(
    ...fields.map(([id, label, placeholder]) =>
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(id)
          .setLabel(label)
          .setPlaceholder(placeholder)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(id === "family_name" ? 80 : 32),
      ),
    ),
  );
  return modal;
}

type RankComposition = "senior" | "junior";
type RankButtonAction = "choose" | RankComposition;

const rankApplicationButtonIds = {
  primary: "panel:rank_apply",
  senior: "rank:choose:senior",
  junior: "rank:choose:junior",
} as const;

const rankApplicationModalIds = {
  senior: "application:rank:senior",
  junior: "application:rank:junior",
} as const;

const rankApplicationButtonAliases: ReadonlyMap<string, RankButtonAction> = new Map([
  [rankApplicationButtonIds.primary, "choose"],
  ["panel:rank", "choose"],
  [rankApplicationButtonIds.senior, "senior"],
  [rankApplicationButtonIds.junior, "junior"],
  ["rank:senior", "senior"],
  ["rank_senior", "senior"],
  ["application:rank:senior", "senior"],
  ["application:rank_senior", "senior"],
  ["panel:rank:senior", "senior"],
  ["panel:rank_senior", "senior"],
  ["rank:junior", "junior"],
  ["rank_junior", "junior"],
  ["application:rank:junior", "junior"],
  ["application:rank_junior", "junior"],
  ["panel:rank:junior", "junior"],
  ["panel:rank_junior", "junior"],
] as const);

function rankApplicationButtonAction(customId: string): RankButtonAction | null {
  return rankApplicationButtonAliases.get(customId.trim()) ?? null;
}

function rankCompositionFromModalId(customId: string): RankComposition | null {
  if (customId === rankApplicationModalIds.senior) return "senior";
  if (customId === rankApplicationModalIds.junior) return "junior";
  return null;
}

function rankApplicationChoiceComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(rankApplicationButtonIds.senior)
        .setLabel("Старший состав")
        .setEmoji("🏅")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(rankApplicationButtonIds.junior)
        .setLabel("Младший состав")
        .setEmoji("🏅")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function rankApplicationModal(composition: RankComposition): ModalBuilder {
  const rankRange = composition === "senior" ? "8–9" : "1–7";
  const fields = [
    ["rank_nickname", "Ваш никнейм", "Например: Alexander"],
    ["rank_family_name", "Какая семья", "Например: Black Family"],
    ["rank", `Ранг (${rankRange})`, `Только целое число от ${rankRange}`],
  ] as const;
  const modal = new ModalBuilder()
    .setCustomId(rankApplicationModalIds[composition])
    .setTitle(composition === "senior" ? "Подача: Старший состав" : "Подача: Младший состав");
  modal.addComponents(
    ...fields.map(([id, label, placeholder]) =>
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(id)
          .setLabel(label)
          .setPlaceholder(placeholder)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(id === "rank_family_name" ? 80 : 32),
      ),
    ),
  );
  return modal;
}

function removeCompositionModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("family:remove-composition")
    .setTitle("Снять роль состава")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("target_user_id")
          .setLabel("Discord ID или mention пользователя")
          .setPlaceholder("123456789012345678 или @участник")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(32),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("family_name")
          .setLabel("Название семьи")
          .setPlaceholder("Например: Black Family")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80),
      ),
    );
}

function removeCompositionConfirmationComponents(
  targetUserId: string,
  familyRoleId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`remove:confirm:senior:${targetUserId}:${familyRoleId}`)
        .setLabel("Снять старший состав")
        .setEmoji("🏅")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`remove:confirm:junior:${targetUserId}:${familyRoleId}`)
        .setLabel("Снять младший состав")
        .setEmoji("🏅")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("remove:cancel")
        .setLabel("Отмена")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function transferModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("family:transfer")
    .setTitle("Передача семьи")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("target_user_id")
          .setLabel("Discord ID или mention нового владельца")
          .setPlaceholder("123456789012345678 или @участник")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(32),
      ),
    );
}

function deleteModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("family:delete")
    .setTitle("Удаление семьи")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("Причина удаления")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMinLength(3)
          .setMaxLength(500),
      ),
    );
}

function rejectModal(kind: "application" | "transfer", id: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`review:reject:${kind}:${id}`)
    .setTitle("Причина отказа")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("Укажите причину")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMinLength(3)
          .setMaxLength(500),
      ),
    );
}

function currentPanelComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("panel:apply")
        .setLabel("Заявление на получение роли лидера")
        .setEmoji("📝")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(rankApplicationButtonIds.primary)
        .setLabel("Подача для получения роли: Старшего состава/Младшего состава")
        .setEmoji("🏅")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("panel:delete")
        .setLabel("Удалить семью")
        .setEmoji("🗑️")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("panel:transfer")
        .setLabel("Передать семью")
        .setEmoji("🔄")
        .setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("panel:remove-composition")
        .setLabel("Убрать роль старшего состава / младшего состава")
        .setEmoji("🗑️")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function reviewComponents(kind: "application" | "transfer", id: number): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`review:approve:${kind}:${id}`)
        .setLabel("Одобрить")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`review:reject:${kind}:${id}`)
        .setLabel("Отказать")
        .setEmoji("❌")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function disabledComponents(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("disabled:approve").setLabel("Рассмотрено").setStyle(ButtonStyle.Secondary).setDisabled(true),
    ),
  ];
}

function makePanelEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle("Grand Family Bot")
    .setDescription(
      "Создайте свою семью, соберите команду и управляйте пространством.\n\n" +
        "Выберите действие ниже. Заявление будет рассмотрено кураторами.",
    )
    .addFields(
      { name: "Заявление на получение роли лидера", value: "Заполните форму и отправьте ровно 3 скриншота-доказательства.", inline: false },
      {
        name: "Получение роли",
        value: "Для участника существующей семьи: выберите старший или младший состав, заполните форму и отправьте ровно 2 скриншота-доказательства.",
        inline: false,
      },
      {
        name: "Снятие роли состава",
        value: "Куратор может снять у участника одну роль старшего или младшего состава выбранной семьи.",
        inline: false,
      },
      { name: "Передача", value: "Передайте семью участнику по Discord ID или mention.", inline: true },
      { name: "Удаление", value: "Удаление выполняется только после одобрения куратора.", inline: true },
    )
    .setFooter({ text: "Grand Family Bot · честная модерация семей" })
    .setTimestamp();
}

async function ensureFamilyRole(
  guild: Guild,
  name: string,
  colorHex: string,
  minimumPosition: number,
  botMember: GuildMember,
): Promise<Role> {
  const existing = guild.roles.cache.find((role) => role.name === name && !role.managed);
  const role =
    existing ??
    (await guild.roles.create({
      name,
      color: colorHex as `#${string}`,
      reason: "Grand Family Bot: создание семейной роли",
    }));
  if (!roleIsUsable(role, botMember)) {
    throw new Error(`Бот не может управлять ролью «${name}». Поднимите роль бота выше.`);
  }
  if (role.position <= minimumPosition) {
    await role.setPosition(minimumPosition + 1, { reason: "Grand Family Bot: соблюдение иерархии ролей" });
  }
  return role;
}

async function setMemberRank(member: GuildMember, family: Family, settings: Settings): Promise<void> {
  const managedRoleIds = relevantRankRoleIds(family, settings);
  await member.roles.remove(managedRoleIds, "Grand Family Bot: очистка старых рангов");
  await member.roles.add(rankRoleIds(family, settings), "Grand Family Bot: выдача ранга семьи");
}

async function createFamilyResources(
  guild: Guild,
  settings: Settings,
  application: Application,
  botMember: GuildMember,
): Promise<{ familyRole: Role; ldRole: Role; categoryId: string; textChannelId: string; voiceChannelId: string }> {
  if (!application.familyName || !application.colorHex || !application.rank || !application.nickname) {
    throw new Error("Заявка неполная: отсутствуют данные семьи.");
  }
  const familyName = application.familyName;
  const colorHex = application.colorHex;
  const existingFamily = guild.roles.cache.find(
    (role) => role.name === `Семья ${familyName}` && !role.managed,
  );
  if (existingFamily && !roleIsUsable(existingFamily, botMember)) {
    throw new Error(`Роль «Семья ${familyName}» уже существует, но бот не может ею управлять.`);
  }
  const familyBaseRole = await guild.roles.fetch(settings.familyRoleId);
  const leaderRole = await guild.roles.fetch(settings.leaderRoleId);
  if (!familyBaseRole || !leaderRole) throw new Error("Настроечная роль не найдена.");

  const existingLdRole = guild.roles.cache.find(
    (role) => role.name === `LD ${familyName}` && !role.managed,
  );
  if (existingFamily && !existingLdRole) {
    throw new Error(`Роль «LD ${familyName}» уже существует не полностью: роль лидера не найдена.`);
  }
  const familyRole =
    existingFamily ??
    (await ensureFamilyRole(
      guild,
      `Семья ${familyName}`,
      colorHex,
      familyBaseRole.position,
      botMember,
    ));
  const ldRole =
    existingLdRole ??
    (await ensureFamilyRole(
      guild,
      `LD ${familyName}`,
      colorHex,
      leaderRole.position,
      botMember,
    ));

  const categoryName = `${familyHeartEmoji(colorHex)} | Семья "${familyName}"`;
  const channels = (await guild.channels.fetch()).filter(
    (channel): channel is NonNullable<typeof channel> => channel !== null,
  );
  const existingCategory = channels.find(
    (channel) =>
      channel.type === ChannelType.GuildCategory &&
      (channel.name === categoryName ||
        channel.name === `${familyHeartEmoji(colorHex)} | Семья ${familyName}`),
  );

  if (existingFamily) {
    if (!existingCategory) {
      throw new Error(`Семья «${familyName}» уже существует, но её категория не найдена.`);
    }

    const familyChannels = channels.filter((channel) => channel.parentId === existingCategory.id);
    const existingNewsChannel = familyChannels.find(
      (channel) => channel.type === ChannelType.GuildText && channel.name === "🪙┃новости",
    );
    const existingChatChannel = familyChannels.find(
      (channel) => channel.type === ChannelType.GuildText && channel.name === "💬┃общение",
    );
    const existingCuratorLeaderChannel = familyChannels.find(
      (channel) => channel.type === ChannelType.GuildText && channel.name === "☀️┃куратор-лидер",
    );
    if (!existingNewsChannel || !existingChatChannel || !existingCuratorLeaderChannel) {
      throw new Error(`Семья «${familyName}» уже существует, но не все её каналы найдены.`);
    }

    return {
      familyRole: existingFamily,
      ldRole,
      categoryId: existingCategory.id,
      textChannelId: existingNewsChannel.id,
      voiceChannelId: existingChatChannel.id,
    };
  }

  const botOverwrite = {
    id: botMember.id,
    type: OverwriteType.Member,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.Connect,
      PermissionFlagsBits.Speak,
    ],
  };
  const categoryOverwrites = [
    { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    { id: familyRole.id, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel] },
    { id: ldRole.id, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel] },
    { id: settings.mainCuratorRoleId, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel] },
    { id: settings.deputyCuratorRoleId, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel] },
    botOverwrite,
  ];
  const familyNewsOverwrites = [
    { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: familyRole.id,
      type: OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
      deny: [PermissionFlagsBits.SendMessages],
    },
    {
      id: ldRole.id,
      type: OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
    { id: settings.mainCuratorRoleId, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    { id: settings.deputyCuratorRoleId, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    botOverwrite,
  ];
  const familyChatOverwrites = [
    { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: familyRole.id,
      type: OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
    {
      id: ldRole.id,
      type: OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
    {
      id: settings.mainCuratorRoleId,
      type: OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
    {
      id: settings.deputyCuratorRoleId,
      type: OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
    botOverwrite,
  ];
  const curatorLeaderOverwrites = [
    { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    { id: familyRole.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    {
      id: ldRole.id,
      type: OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
    {
      id: settings.mainCuratorRoleId,
      type: OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
    {
      id: settings.deputyCuratorRoleId,
      type: OverwriteType.Role,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    },
    botOverwrite,
  ];
  const category = await guild.channels.create({
    name: categoryName,
    type: ChannelType.GuildCategory,
    permissionOverwrites: categoryOverwrites,
    reason: "Grand Family Bot: создание категории семьи",
  });
  const newsChannel = await guild.channels.create({
    name: "🪙┃новости",
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: familyNewsOverwrites,
    reason: "Grand Family Bot: создание канала новостей семьи",
  });
  const chatChannel = await guild.channels.create({
    name: "💬┃общение",
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: familyChatOverwrites,
    reason: "Grand Family Bot: создание канала общения семьи",
  });
  await guild.channels.create({
    name: "☀️┃куратор-лидер",
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: curatorLeaderOverwrites,
    reason: "Grand Family Bot: создание канала куратора и лидера семьи",
  });
  return {
    familyRole,
    ldRole,
    categoryId: category.id,
    textChannelId: newsChannel.id,
    voiceChannelId: chatChannel.id,
  };
}

async function deleteChannelIfPresent(guild: Guild, id: string): Promise<void> {
  const channel = await guild.channels.fetch(id).catch(() => null);
  if (channel) await channel.delete("Grand Family Bot: удаление семьи");
}

async function deleteRoleIfPresent(guild: Guild, id: string): Promise<void> {
  const role = await guild.roles.fetch(id).catch(() => null);
  if (role && !role.managed) await role.delete("Grand Family Bot: удаление семьи");
}

async function downloadEvidenceImages(evidenceUrls: string[]): Promise<AttachmentBuilder[]> {
  return Promise.all(
    evidenceUrls.map(async (url, index) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Не удалось получить доказательство ${index + 1} для вложения.`);
      }
      const extension = url.match(/\.(png|jpe?g|gif|webp|bmp)(?:[?&]|$)/i)?.[1]?.toLowerCase() ?? "png";
      const image = Buffer.from(await response.arrayBuffer());
      return new AttachmentBuilder(image, { name: `доказательство-${index + 1}.${extension}` });
    }),
  );
}

function requiredEvidenceCount(application: Application): 2 | 3 {
  return application.type === "rank" ? 2 : 3;
}

async function sendApplicationReview(
  guild: Guild,
  settings: Settings,
  application: Application,
  db: BotDatabase,
): Promise<string> {
  const channel = await guild.channels.fetch(settings.applicationsChannelId);
  if (!channel?.isTextBased() || !("send" in channel)) throw new Error("Канал заявлений недоступен.");
  const evidenceCount = requiredEvidenceCount(application);
  if (application.evidenceUrls.length !== evidenceCount) {
    throw new Error(`Для отправки заявки требуется ровно ${evidenceCount} скриншота.`);
  }
  const evidenceFiles = await downloadEvidenceImages(application.evidenceUrls);
  const isRankApplication = application.type === "rank";
  const fields = [
    { name: "Заявитель", value: `<@${application.userId}>`, inline: true },
    { name: "Никнейм", value: application.nickname ?? "—", inline: true },
    { name: isRankApplication ? "Семья" : "Название семьи", value: application.familyName ?? "—", inline: true },
  ];
  if (!isRankApplication) {
    fields.push({ name: "HEX-цвет", value: application.colorHex ?? "—", inline: true });
  }
  fields.push(
    { name: "Ранг", value: String(application.rank ?? "—"), inline: true },
    { name: "Доказательства", value: `${evidenceCount} скриншота прикреплены к этому сообщению.`, inline: false },
  );
  const embed = new EmbedBuilder()
    .setColor(application.colorHex ? parseInt(application.colorHex.slice(1), 16) : 0x8b5cf6)
    .setTitle(isRankApplication ? "Заявка на получение роли: Старший состав / Младший состав" : "Заявление на получение роли лидера")
    .addFields(fields)
    .setFooter({ text: `Заявка #${application.id}` })
    .setTimestamp();
  const message = await channel.send({
    content: `<@&${settings.mainCuratorRoleId}> <@&${settings.deputyCuratorRoleId}>`,
    allowedMentions: { roles: [settings.mainCuratorRoleId, settings.deputyCuratorRoleId] },
    embeds: [embed],
    files: evidenceFiles,
    components: reviewComponents("application", application.id),
  });
  db.updateApplicationEvidence(application.id, application.evidenceUrls, message.id);
  return message.id;
}

async function updateReviewMessage(
  guild: Guild,
  channelId: string,
  messageId: string | null,
  content: string,
): Promise<void> {
  if (!messageId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !("messages" in channel)) return;
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (message) await message.edit({ content, components: disabledComponents() });
}

async function notifyUser(guild: Guild, userId: string, content: string): Promise<void> {
  const user = await guild.client.users.fetch(userId).catch(() => null);
  if (user) await user.send(content).catch(() => undefined);
}

function isPanelMessage(message: import("discord.js").Message): boolean {
  if (message.embeds.some((embed) => embed.title === "Grand Family Bot")) return true;
  return message.components.some((row) =>
    "components" in row &&
    row.components.some(
      (component) =>
        "customId" in component &&
        typeof component.customId === "string" &&
        component.customId.startsWith("panel:"),
    ),
  );
}

// The current panel is identified by its unique rank-application button.
// This prevents an older panel message from being selected just because it
// happens to have the same embed title or another legacy panel button.
function isCurrentPanelMessage(message: import("discord.js").Message): boolean {
  return message.components.some((row) =>
    "components" in row &&
    row.components.some(
      (component) =>
        "customId" in component &&
        component.customId === rankApplicationButtonIds.primary,
    ),
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

async function findExistingPanelMessage(
  guild: Guild,
  preferredChannelId: string | null,
  preferredMessageId: string | null,
): Promise<import("discord.js").Message | null> {
  if (!preferredChannelId) return null;
  const preferredChannel =
    guild.channels.cache.get(preferredChannelId) ??
    (await withTimeout(guild.channels.fetch(preferredChannelId), 5_000));
  if (!preferredChannel?.isTextBased() || !("messages" in preferredChannel) || !("send" in preferredChannel)) {
    return null;
  }
  if (preferredMessageId) {
    const savedMessage = await withTimeout(preferredChannel.messages.fetch(preferredMessageId), 5_000);
    // A saved legacy panel is still safe to reuse: syncPanelForGuild() will
    // immediately replace its components with the current panel.
    if (savedMessage && isPanelMessage(savedMessage)) return savedMessage;
  }

  const recentMessages = await withTimeout(preferredChannel.messages.fetch({ limit: 100 }), 5_000);
  if (!recentMessages) return null;

  // Prefer the current panel over any legacy panel when no message ID is saved.
  const currentPanel = recentMessages.find((message) => isCurrentPanelMessage(message));
  if (currentPanel) return currentPanel;

  // If only an old panel exists, reuse it and overwrite it with the current
  // components instead of leaving the old version visible after /panel.
  return recentMessages.find((message) => isPanelMessage(message)) ?? null;
}

async function syncPanelForGuild(
  guild: Guild,
  db: BotDatabase,
  createIfMissing: boolean,
  channelHint: string | null = null,
): Promise<{ messageId: string; created: boolean } | null> {
  const settings = db.getSettings(guild.id);

  const panelMessage = await findExistingPanelMessage(
    guild,
    settings?.panelChannelId ?? channelHint,
    settings?.panelMessageId ?? null,
  );
  if (panelMessage) {
    await panelMessage.edit({ embeds: [makePanelEmbed()], components: currentPanelComponents() });
    if (settings && settings.panelMessageId !== panelMessage.id) {
      db.setPanelMessageId(guild.id, panelMessage.id);
    }
    return { messageId: panelMessage.id, created: false };
  }

  if (!createIfMissing || !settings) return null;
  const configuredChannel = await guild.channels.fetch(settings.panelChannelId).catch(() => null);
  if (!configuredChannel?.isTextBased() || !("send" in configuredChannel)) return null;
  const createdMessage = await configuredChannel.send({
    embeds: [makePanelEmbed()],
    components: currentPanelComponents(),
  });
  db.setPanelMessageId(guild.id, createdMessage.id);
  return { messageId: createdMessage.id, created: true };
}

async function createPanel(interaction: ChatInputCommandInteraction, db: BotDatabase): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guild) return void (await interaction.editReply("Эта команда доступна только на сервере."));
  const result = await syncPanelForGuild(interaction.guild, db, true, interaction.channelId);
  if (!result) {
    return void (await interaction.editReply(
      db.getSettings(interaction.guild.id)
        ? "Канал панели недоступен или сообщение панели не найдено. Проверьте права бота и настройки."
        : "Существующая панель не найдена. Сначала выполните `/setup` и завершите настройку.",
    ));
  }
  const settings = db.getSettings(interaction.guild.id);
  const channelId = settings?.panelChannelId ?? interaction.channelId;
  await interaction.editReply(
    result.created ? `Панель создана в <#${channelId}>.` : `Панель обновлена в <#${channelId}>.`,
  );
}

async function handleSetup(interaction: ChatInputCommandInteraction, db: BotDatabase): Promise<void> {
  if (!interaction.guild) return void (await interaction.reply({ content: "Эта команда доступна только на сервере.", flags: MessageFlags.Ephemeral }));
  // The owner is loaded during ClientReady. Do not await an API request here:
  // slash commands have only a three-second acknowledgement window, while
  // this command must open a modal rather than defer a reply.
  const ownerId = interaction.client.application.owner?.id;
  if (!ownerId) {
    return void (await interaction.reply({
      content: "Бот ещё завершает загрузку данных приложения. Повторите команду через несколько секунд.",
      flags: MessageFlags.Ephemeral,
    }));
  }
  if (!ownerId || ownerId !== interaction.user.id) {
    return void (await interaction.reply({ content: "Только владелец Discord Application может выполнять настройку.", flags: MessageFlags.Ephemeral }));
  }
  setupDrafts.delete(setupKey(interaction.guild.id, interaction.user.id));
  await interaction.showModal(setupStageOneModal());
}

async function handleStageOne(interaction: import("discord.js").ModalSubmitInteraction, db: BotDatabase): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guild) return void (await interaction.editReply("Эта форма доступна только на сервере."));
  const draft: SetupStageOneDraft = {
    guildId: interaction.guild.id,
    panelChannelId: interaction.fields.getTextInputValue("panel_channel_id").trim(),
    applicationsChannelId: interaction.fields.getTextInputValue("applications_channel_id").trim(),
    mainCuratorRoleId: interaction.fields.getTextInputValue("main_curator_role_id").trim(),
    deputyCuratorRoleId: interaction.fields.getTextInputValue("deputy_curator_role_id").trim(),
    leaderRoleId: interaction.fields.getTextInputValue("leader_role_id").trim(),
  };
  try {
    for (const id of [draft.panelChannelId, draft.applicationsChannelId, draft.mainCuratorRoleId, draft.deputyCuratorRoleId, draft.leaderRoleId]) {
      if (!DISCORD_ID_PATTERN.test(id)) throw new Error(`Значение «${id}» не похоже на Discord ID.`);
    }
    await validateSetupIds(interaction.guild, {
      ...draft,
      deputyLeaderRoleId: draft.leaderRoleId,
      seniorRoleId: draft.leaderRoleId,
      familyRoleId: draft.leaderRoleId,
    });
    setupDrafts.set(setupKey(interaction.guild.id, interaction.user.id), { expiresAt: Date.now() + SETUP_TTL_MS, draft });
    await interaction.editReply({
      content: "Этап 1 проверен. Нажмите кнопку ниже, чтобы открыть этап 2.",
      components: setupContinueComponents(),
    });
  } catch (error) {
    await interaction.editReply({ content: `Не удалось проверить этап 1: ${errorText(error)}` });
  }
}

async function handleStageTwo(interaction: import("discord.js").ModalSubmitInteraction, db: BotDatabase): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guild) return void (await interaction.editReply("Эта форма доступна только на сервере."));
  const key = setupKey(interaction.guild.id, interaction.user.id);
  const saved = setupDrafts.get(key);
  if (!saved || saved.expiresAt < Date.now()) {
    setupDrafts.delete(key);
    return void (await interaction.editReply("Сессия настройки истекла. Запустите `/setup` заново."));
  }
  const settings: SetupDraft = {
    ...saved.draft,
    deputyLeaderRoleId: interaction.fields.getTextInputValue("deputy_leader_role_id").trim(),
    seniorRoleId: interaction.fields.getTextInputValue("senior_role_id").trim(),
    familyRoleId: interaction.fields.getTextInputValue("family_role_id").trim(),
  };
  try {
    for (const id of [settings.deputyLeaderRoleId, settings.seniorRoleId, settings.familyRoleId]) {
      if (!DISCORD_ID_PATTERN.test(id)) throw new Error(`Значение «${id}» не похоже на Discord ID.`);
    }
    await validateSetupIds(interaction.guild, settings);
    db.saveSettings(settings);
    setupDrafts.delete(key);
    await interaction.editReply({
      content:
        "Настройка завершена. Владелец ввёл 8 ID:\n" +
        "1) канал панели, 2) канал заявлений, 3) роль главного куратора, 4) роль заместителя куратора,\n" +
        "5) роль лидера, 6) роль заместителя, 7) роль старшего состава, 8) базовая роль семьи.\n\n" +
        "Теперь выполните `/panel`.",
    });
  } catch (error) {
    await interaction.editReply({ content: `Не удалось сохранить настройку: ${errorText(error)}` });
  }
}

async function startApplication(interaction: import("discord.js").ModalSubmitInteraction, db: BotDatabase): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guild) return void (await interaction.editReply("Эта форма доступна только на сервере."));
  const settings = db.getSettings(interaction.guild.id);
  if (!settings) return void (await interaction.editReply("Сначала завершите настройку бота через `/setup`."));
  const nickname = interaction.fields.getTextInputValue("nickname").trim();
  const familyName = interaction.fields.getTextInputValue("family_name").trim();
  const colorHex = interaction.fields.getTextInputValue("color_hex").trim();
  const rankText = interaction.fields.getTextInputValue("rank").trim();
  const rank = Number(rankText);
  if (!nickname || !familyName) return void (await interaction.editReply("Никнейм и название семьи обязательны."));
  if (!HEX_PATTERN.test(colorHex)) return void (await interaction.editReply("HEX-цвет должен быть в формате `#RRGGBB`."));
   if (rank !== 10) return void (await interaction.editReply("Для заявления на роль лидера нужно указать ровно ранг 10."));
  const tempChannel = await interaction.guild.channels.create({
    name: `заявка-${interaction.user.username}`.slice(0, 90),
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: interaction.guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
      { id: interaction.user.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory] },
      { id: interaction.client.user.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
    ],
    reason: "Grand Family Bot: временный канал заявления",
  });
  const applicationId = db.createApplication({
    guildId: interaction.guild.id,
    type: "create",
    userId: interaction.user.id,
    nickname,
    familyName,
    colorHex,
    rank,
    tempChannelId: tempChannel.id,
  });
  await tempChannel.send({
    content:
       `<@${interaction.user.id}>, отправьте **ровно 3 скриншота** одним или несколькими сообщениями.\n` +
       "Принимаются только изображения. После третьего скриншота заявка будет отправлена главному куратору и его заместителю автоматически.",
  });
  await interaction.editReply(`Канал для доказательств создан: <#${tempChannel.id}>.`);
}

async function startRankApplication(interaction: import("discord.js").ModalSubmitInteraction, db: BotDatabase): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guild) return void (await interaction.editReply("Эта форма доступна только на сервере."));
  const settings = db.getSettings(interaction.guild.id);
  if (!settings) return void (await interaction.editReply("Сначала завершите настройку бота через `/setup`."));

  const nickname = interaction.fields.getTextInputValue("rank_nickname").trim();
  const familyName = interaction.fields.getTextInputValue("rank_family_name").trim();
  const rank = Number(interaction.fields.getTextInputValue("rank").trim());
  const composition = rankCompositionFromModalId(interaction.customId);
  if (!nickname || !familyName) return void (await interaction.editReply("Никнейм и название семьи обязательны."));
  const isAllowedRank =
    Number.isInteger(rank) &&
    (composition === "senior" ? rank >= 8 && rank <= 9 : composition === "junior" ? rank >= 1 && rank <= 7 : rank >= 1 && rank <= 9);
  if (!isAllowedRank) {
    const rankRange = composition === "senior" ? "8–9" : composition === "junior" ? "1–7" : "1–9";
    return void (await interaction.editReply(`Для этой заявки можно выбрать только целый ранг от ${rankRange}.`));
  }

  const actualFamilies = await fetchActualDiscordFamilies(interaction.guild);
  const actualFamily = findActualDiscordFamily(actualFamilies, familyName);
  if (!actualFamily) {
    return void (await interaction.editReply(`Семья «${familyName}» не существует. Заявка доступна только для существующих семей.`));
  }

  const tempChannel = await interaction.guild.channels.create({
    name: `роль-${interaction.user.username}`.slice(0, 90),
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: interaction.guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: interaction.user.id,
        type: OverwriteType.Member,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
      {
        id: interaction.client.user.id,
        type: OverwriteType.Member,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
    ],
    reason: "Grand Family Bot: временный канал заявки на получение роли",
  });
  const applicationId = db.createApplication({
    guildId: interaction.guild.id,
    type: "rank",
    userId: interaction.user.id,
    nickname,
    familyName: actualFamily.name,
    rank,
    tempChannelId: tempChannel.id,
  });
  await tempChannel.send({
    content:
       `<@${interaction.user.id}>, отправьте **ровно 2 скриншота** одним или несколькими сообщениями.\n` +
       "Принимаются только изображения. После второго скриншота заявка будет отправлена главному куратору и его заместителю автоматически.",
  });
  await interaction.editReply(`Канал для доказательств создан: <#${tempChannel.id}>.`);
}

async function handleEvidence(message: import("discord.js").Message, db: BotDatabase): Promise<void> {
  if (message.author.bot || !message.guild) return;
  const pending = findApplicationByTempChannel(db, message.channel.id);
  if (!pending || pending.status !== "collecting_evidence" || pending.userId !== message.author.id) return;
  const evidenceCount = requiredEvidenceCount(pending);
  const images = [...message.attachments.values()].filter((attachment) => {
    return Boolean(attachment.contentType?.startsWith("image/")) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(attachment.name ?? "");
  });
  if (images.length !== message.attachments.size || images.length === 0) {
    await message.reply("Принимаются только скриншоты-изображения. Отправьте недостающие файлы ещё раз.").catch(() => undefined);
    return;
  }
  if (images.length > evidenceCount) {
    await message.reply(`Нужно отправить ровно ${evidenceCount} скриншота. В этом сообщении слишком много файлов.`).catch(() => undefined);
    return;
  }
  const existingCount = pending.evidenceUrls.length;
  const urls = [...pending.evidenceUrls, ...images.map((attachment) => attachment.url)];
  if (urls.length > evidenceCount) {
    const remaining = evidenceCount - existingCount;
    await message.reply(`Уже принято ${existingCount}. Отправьте только ${remaining} скриншот${remaining === 1 ? "" : "а"}.`).catch(() => undefined);
    return;
  }
  if (urls.length < evidenceCount) {
    const remaining = evidenceCount - urls.length;
    await message.reply(`Принято ${urls.length}/${evidenceCount}. Осталось отправить: ${remaining}.`).catch(() => undefined);
    updateEvidenceOnly(db, pending.id, urls);
    return;
  }
  const appWithEvidence = { ...pending, evidenceUrls: urls };
  try {
    const settings = db.getSettings(message.guild.id);
    if (!settings) throw new Error("Настройка бота не найдена.");
    await sendApplicationReview(message.guild, settings, appWithEvidence, db);
    if (message.channel.isTextBased() && "send" in message.channel) {
       await message.channel.send(`Все ${evidenceCount} доказательства приняты. Канал будет закрыт.`).catch(() => undefined);
    }
    await message.channel.delete("Grand Family Bot: доказательства собраны");
  } catch (error) {
    logger.error({ err: error, applicationId: pending.id }, "Unable to send application review");
    await message.reply(`Не удалось отправить заявление кураторам: ${errorText(error)}`).catch(() => undefined);
  }
}

function findApplicationByTempChannel(db: BotDatabase, channelId: string): Application | null {
  return db.getApplicationByTempChannel(channelId);
}

function updateEvidenceOnly(db: BotDatabase, id: number, urls: string[]): void {
  db.updateEvidenceUrls(id, urls);
}

async function approveApplication(
  interaction: ButtonInteraction,
  id: number,
  db: BotDatabase,
): Promise<void> {
  await interaction.deferUpdate();
  const guild = interaction.guild;
  if (!guild) return void (await interaction.followUp({ content: "Эта заявка доступна только на сервере.", flags: MessageFlags.Ephemeral }));
  const settings = db.getSettings(guild.id);
  if (!settings) return void (await interaction.followUp({ content: "Настройка бота не найдена.", flags: MessageFlags.Ephemeral }));
  const member = await guild.members.fetch(interaction.user.id);
  if (!isCurator(member, settings)) return void (await interaction.followUp({ content: "Только главный куратор или его заместитель может рассматривать заявки.", flags: MessageFlags.Ephemeral }));
  const application = db.getApplication(id);
  if (!application || application.status !== "pending") return void (await interaction.followUp({ content: "Эта заявка уже рассмотрена или не найдена.", flags: MessageFlags.Ephemeral }));
  const existingFamily = application.familyName ? db.getFamilyByName(guild.id, application.familyName) : null;
  try {
    const owner = await guild.members.fetch(application.userId);
    if (existingFamily) {
      // An existing family already owns its roles and channels. Only apply
      // the requested rank to the applicant; never create family resources.
      const familyAtRequestedRank: Family = { ...existingFamily, rank: application.rank! };
      await setMemberRank(owner, familyAtRequestedRank, settings);
      db.setApplicationStatus(id, "approved", interaction.user.id);
      await updateReviewMessage(guild, settings.applicationsChannelId, application.reviewMessageId, `✅ Заявка #${id} одобрена куратором <@${interaction.user.id}>.`);
      await notifyUser(guild, application.userId, approvalNotification(application.rank!));
      await interaction.followUp({ content: `Заявка #${id} одобрена. Существующая роль выдана.`, flags: MessageFlags.Ephemeral });
      return;
    }

    const bot = await fetchBotMember(guild);
    const resources = await createFamilyResources(guild, settings, application, bot);
    const family: Family = {
      id: 0,
      guildId: guild.id,
      name: application.familyName!,
      ownerId: application.userId,
      nickname: application.nickname!,
      rank: application.rank!,
      familyRoleId: resources.familyRole.id,
      ldRoleId: resources.ldRole.id,
      categoryId: resources.categoryId,
      textChannelId: resources.textChannelId,
      voiceChannelId: resources.voiceChannelId,
      status: "active",
    };
    const familyId = db.createFamily(family);
    const createdFamily = { ...family, id: familyId };
    await setMemberRank(owner, createdFamily, settings);
    db.setApplicationStatus(id, "approved", interaction.user.id);
    await updateReviewMessage(guild, settings.applicationsChannelId, application.reviewMessageId, `✅ Заявка #${id} одобрена куратором <@${interaction.user.id}>.`);
    await notifyUser(guild, application.userId, approvalNotification(application.rank!));
    await interaction.followUp({ content: `Заявка #${id} одобрена. Семья создана.`, flags: MessageFlags.Ephemeral });
  } catch (error) {
    logger.error({ err: error, applicationId: id }, "Unable to approve family application");
    await interaction.followUp({ content: `Не удалось одобрить заявку: ${errorText(error)}`, flags: MessageFlags.Ephemeral });
  }
}

async function approveRankApplication(
  interaction: ButtonInteraction,
  id: number,
  db: BotDatabase,
): Promise<void> {
  await interaction.deferUpdate();
  const guild = interaction.guild;
  if (!guild) return void (await interaction.followUp({ content: "Эта заявка доступна только на сервере.", flags: MessageFlags.Ephemeral }));
  const settings = db.getSettings(guild.id);
  if (!settings) return void (await interaction.followUp({ content: "Настройка бота не найдена.", flags: MessageFlags.Ephemeral }));
  const reviewer = await guild.members.fetch(interaction.user.id);
  if (!isCurator(reviewer, settings)) {
    return void (await interaction.followUp({
      content: "Только главный куратор или его заместитель может рассматривать заявки.",
      flags: MessageFlags.Ephemeral,
    }));
  }
  const application = db.getApplication(id);
  if (!application || application.type !== "rank" || application.status !== "pending") {
    return void (await interaction.followUp({ content: "Эта заявка уже рассмотрена или не найдена.", flags: MessageFlags.Ephemeral }));
  }
  if (!application.rank || application.rank < 1 || application.rank > 9 || !application.familyName) {
    return void (await interaction.followUp({ content: "Заявка содержит некорректную семью или ранг.", flags: MessageFlags.Ephemeral }));
  }
  const actualFamilies = await fetchActualDiscordFamilies(guild);
  const actualFamily = findActualDiscordFamily(actualFamilies, application.familyName);
  const familyRole = actualFamily?.roles[0];
  if (!actualFamily) {
    return void (await interaction.followUp({
      content: "Указанная семья больше не существует. Новые ресурсы для этой заявки создаваться не будут.",
      flags: MessageFlags.Ephemeral,
    }));
  }
  if (!familyRole) {
    return void (await interaction.followUp({
      content: `У семьи «${actualFamily.name}» не найдена основная роль на сервере Discord.`,
      flags: MessageFlags.Ephemeral,
    }));
  }
  const family: Family = {
    id: application.familyId ?? 0,
    guildId: guild.id,
    name: actualFamily.name,
    ownerId: application.userId,
    nickname: application.nickname ?? "",
    rank: application.rank,
    familyRoleId: familyRole.id,
    ldRoleId: familyRole.id,
    categoryId: actualFamily.categories[0]?.id ?? "",
    textChannelId: "",
    voiceChannelId: "",
    status: "active",
  };

  try {
    const owner = await guild.members.fetch(application.userId);
    await setMemberRank(owner, { ...family, rank: application.rank }, settings);
    db.setApplicationStatus(id, "approved", interaction.user.id);
    await updateReviewMessage(guild, settings.applicationsChannelId, application.reviewMessageId, `✅ Заявка #${id} одобрена куратором <@${interaction.user.id}>.`);
    await notifyUser(guild, application.userId, approvalNotification(application.rank));
    await interaction.followUp({ content: `Заявка #${id} одобрена. Существующая роль выдана.`, flags: MessageFlags.Ephemeral });
  } catch (error) {
    logger.error({ err: error, applicationId: id }, "Unable to approve rank application");
    await interaction.followUp({ content: `Не удалось одобрить заявку: ${errorText(error)}`, flags: MessageFlags.Ephemeral });
  }
}

async function rejectApplication(interaction: import("discord.js").ModalSubmitInteraction, id: number, db: BotDatabase): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  if (!guild) return void (await interaction.editReply("Эта заявка доступна только на сервере."));
  const settings = db.getSettings(guild.id);
  if (!settings) return void (await interaction.editReply("Настройка бота не найдена."));
  const member = await guild.members.fetch(interaction.user.id);
  if (!isCurator(member, settings)) return void (await interaction.editReply("Недостаточно прав куратора."));
  const application = db.getApplication(id);
  if (!application || application.status !== "pending") return void (await interaction.editReply("Эта заявка уже рассмотрена."));
  const reason = interaction.fields.getTextInputValue("reason").trim();
  db.setApplicationStatus(id, "rejected", interaction.user.id, reason);
  await updateReviewMessage(guild, settings.applicationsChannelId, application.reviewMessageId, `❌ Заявка #${id} отклонена куратором <@${interaction.user.id}>.\nПричина: ${reason}`);
  await notifyUser(guild, application.userId, rejectionNotification(reason));
  await interaction.editReply("Заявка отклонена, причина сохранена.");
}

async function createTransfer(interaction: import("discord.js").ModalSubmitInteraction, db: BotDatabase): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  if (!guild) return void (await interaction.editReply("Эта форма доступна только на сервере."));
  const settings = db.getSettings(guild.id);
  if (!settings) return void (await interaction.editReply("Сначала настройте бота."));
  const family = db.getFamilyByOwner(guild.id, interaction.user.id);
  if (!family) return void (await interaction.editReply("Вы не являетесь владельцем активной семьи."));
  const targetId = cleanId(interaction.fields.getTextInputValue("target_user_id"));
  if (!DISCORD_ID_PATTERN.test(targetId)) return void (await interaction.editReply("Укажите корректный Discord ID или mention."));
  const target = await guild.members.fetch(targetId).catch(() => null);
  if (!target) return void (await interaction.editReply("Пользователь с таким ID не найден на сервере."));
  if (target.user.bot) return void (await interaction.editReply("Нельзя передать семью боту."));
  if (target.id === interaction.user.id) return void (await interaction.editReply("Новый владелец должен быть другим участником."));
  const transferId = db.createTransfer({ guildId: guild.id, familyId: family.id, fromUserId: interaction.user.id, targetUserId: target.id });
  const channel = await guild.channels.fetch(settings.applicationsChannelId);
  if (!channel?.isTextBased() || !("send" in channel)) return void (await interaction.editReply("Канал заявлений недоступен."));
  const message = await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xf59e0b)
        .setTitle("Заявка на передачу семьи")
        .setDescription(`Семья **${family.name}**\nОт: <@${interaction.user.id}>\nКому: <@${target.id}>`)
        .setFooter({ text: `Передача #${transferId}` })
        .setTimestamp(),
    ],
    components: reviewComponents("transfer", transferId),
  });
  db.setTransferReviewMessage(transferId, message.id);
  await interaction.editReply(`Заявка на передачу отправлена кураторам. Номер: #${transferId}.`);
}

async function approveTransfer(interaction: ButtonInteraction, id: number, db: BotDatabase): Promise<void> {
  await interaction.deferUpdate();
  const guild = interaction.guild;
  if (!guild) return;
  const settings = db.getSettings(guild.id);
  if (!settings) return void (await interaction.followUp({ content: "Настройка не найдена.", flags: MessageFlags.Ephemeral }));
  const reviewer = await guild.members.fetch(interaction.user.id);
  if (!isCurator(reviewer, settings)) return void (await interaction.followUp({ content: "Недостаточно прав куратора.", flags: MessageFlags.Ephemeral }));
  const transfer = db.getTransfer(id);
  if (!transfer || transfer.status !== "pending") return void (await interaction.followUp({ content: "Эта передача уже рассмотрена.", flags: MessageFlags.Ephemeral }));
  const family = db.getFamily(transfer.familyId);
  if (!family) return void (await interaction.followUp({ content: "Семья уже удалена.", flags: MessageFlags.Ephemeral }));
  try {
    const oldOwner = await guild.members.fetch(transfer.fromUserId).catch(() => null);
    const newOwner = await guild.members.fetch(transfer.targetUserId);
    if (oldOwner) await oldOwner.roles.remove(relevantRankRoleIds(family, settings), "Grand Family Bot: передача семьи");
    await setMemberRank(newOwner, family, settings);
    db.updateFamilyOwner(family.id, newOwner.id);
    db.setTransferStatus(id, "approved", interaction.user.id);
    await updateReviewMessage(guild, settings.applicationsChannelId, transfer.reviewMessageId, `✅ Передача #${id} одобрена куратором <@${interaction.user.id}>.`);
    await notifyUser(guild, newOwner.id, `Вы стали владельцем семьи **${family.name}**.`);
    await interaction.followUp({ content: `Передача #${id} одобрена.`, flags: MessageFlags.Ephemeral });
  } catch (error) {
    logger.error({ err: error, transferId: id }, "Unable to approve family transfer");
    await interaction.followUp({ content: `Не удалось одобрить передачу: ${errorText(error)}`, flags: MessageFlags.Ephemeral });
  }
}

async function rejectTransfer(interaction: import("discord.js").ModalSubmitInteraction, id: number, db: BotDatabase): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  if (!guild) return;
  const settings = db.getSettings(guild.id);
  if (!settings) return void (await interaction.editReply("Настройка не найдена."));
  const reviewer = await guild.members.fetch(interaction.user.id);
  if (!isCurator(reviewer, settings)) return void (await interaction.editReply("Недостаточно прав куратора."));
  const transfer = db.getTransfer(id);
  if (!transfer || transfer.status !== "pending") return void (await interaction.editReply("Эта передача уже рассмотрена."));
  const reason = interaction.fields.getTextInputValue("reason").trim();
  db.setTransferStatus(id, "rejected", interaction.user.id, reason);
  await updateReviewMessage(guild, settings.applicationsChannelId, transfer.reviewMessageId, `❌ Передача #${id} отклонена.\nПричина: ${reason}`);
  await notifyUser(guild, transfer.fromUserId, `Передача семьи отклонена.\nПричина: ${reason}`);
  await interaction.editReply("Передача отклонена.");
}

async function createDeleteRequest(interaction: import("discord.js").ModalSubmitInteraction, db: BotDatabase): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  if (!guild) return void (await interaction.editReply("Эта форма доступна только на сервере."));
  const settings = db.getSettings(guild.id);
  if (!settings) return void (await interaction.editReply("Сначала настройте бота."));
  const family = db.getFamilyByOwner(guild.id, interaction.user.id);
  if (!family) return void (await interaction.editReply("Вы не являетесь владельцем активной семьи."));
  const reason = interaction.fields.getTextInputValue("reason").trim();
  const applicationId = db.createApplication({
    guildId: guild.id,
    type: "delete",
    userId: interaction.user.id,
    familyId: family.id,
    reason,
  });
  const channel = await guild.channels.fetch(settings.applicationsChannelId);
  if (!channel?.isTextBased() || !("send" in channel)) return void (await interaction.editReply("Канал заявлений недоступен."));
  const message = await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xef4444)
        .setTitle("Заявка на удаление семьи")
        .setDescription(`Семья **${family.name}**\nВладелец: <@${interaction.user.id}>\nПричина: ${reason}`)
        .setFooter({ text: `Удаление #${applicationId}` })
        .setTimestamp(),
    ],
    components: reviewComponents("application", applicationId),
  });
  db.setApplicationReviewMessage(applicationId, message.id);
  await interaction.editReply(`Заявка на удаление отправлена кураторам. Номер: #${applicationId}.`);
}

async function approveDelete(interaction: ButtonInteraction, id: number, db: BotDatabase): Promise<void> {
  await interaction.deferUpdate();
  const guild = interaction.guild;
  if (!guild) return;
  const settings = db.getSettings(guild.id);
  if (!settings) return void (await interaction.followUp({ content: "Настройка не найдена.", flags: MessageFlags.Ephemeral }));
  const reviewer = await guild.members.fetch(interaction.user.id);
  if (!isCurator(reviewer, settings)) return void (await interaction.followUp({ content: "Недостаточно прав куратора.", flags: MessageFlags.Ephemeral }));
  const application = db.getApplication(id);
  if (!application || application.status !== "pending" || application.type !== "delete" || !application.familyId) {
    return void (await interaction.followUp({ content: "Заявка уже рассмотрена или не найдена.", flags: MessageFlags.Ephemeral }));
  }
  const family = db.getFamily(application.familyId);
  if (!family) return void (await interaction.followUp({ content: "Семья уже удалена.", flags: MessageFlags.Ephemeral }));
  try {
    await deleteChannelIfPresent(guild, family.textChannelId);
    await deleteChannelIfPresent(guild, family.voiceChannelId);
    await deleteChannelIfPresent(guild, family.categoryId);
    await deleteRoleIfPresent(guild, family.ldRoleId);
    await deleteRoleIfPresent(guild, family.familyRoleId);
    db.deleteFamily(family.id);
    db.setApplicationStatus(id, "approved", interaction.user.id);
    await updateReviewMessage(guild, settings.applicationsChannelId, application.reviewMessageId, `✅ Удаление #${id} одобрено. Семья **${family.name}** полностью удалена.`);
    await notifyUser(guild, application.userId, `Семья **${family.name}** полностью удалена после одобрения куратора.`);
    await interaction.followUp({ content: `Семья «${family.name}» полностью удалена.`, flags: MessageFlags.Ephemeral });
  } catch (error) {
    logger.error({ err: error, applicationId: id, familyId: family.id }, "Unable to delete family");
    await interaction.followUp({ content: `Не удалось полностью удалить семью: ${errorText(error)}`, flags: MessageFlags.Ephemeral });
  }
}

async function handleGivePoints(interaction: ChatInputCommandInteraction, db: BotDatabase): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  if (!guild) return void (await interaction.editReply("Эта команда доступна только на сервере."));
  const settings = db.getSettings(guild.id);
  if (!settings) return void (await interaction.editReply("Сначала завершите настройку бота через `/setup`."));

  const issuer = await guild.members.fetch(interaction.user.id);
  if (!isCurator(issuer, settings)) {
    return void (await interaction.editReply("Выдавать баллы могут только главный куратор и его заместитель."));
  }

  const targetUser = interaction.options.getUser("target", true);
  if (targetUser.bot) return void (await interaction.editReply("Нельзя выдавать баллы Discord-боту."));
  const target = await guild.members.fetch(targetUser.id).catch(() => null);
  if (!target) return void (await interaction.editReply("Пользователь с таким ID не найден на сервере."));
  if (!isCurator(target, settings)) {
    return void (await interaction.editReply("Баллы можно выдавать только участникам с ролью главного куратора или заместителя."));
  }

  const amount = interaction.options.getInteger("amount", true);
  try {
    const result = db.grantPoints(guild.id, issuer.id, target.id, amount);
    await interaction.editReply(
      `Куратору <@${target.id}> выдано **${amount.toLocaleString("ru-RU")}** баллов.\n` +
        `Всего у получателя: **${result.recipientTotal.toLocaleString("ru-RU")}**.\n` +
        `Осталось выдать вам сегодня: **${result.issuerDailyRemaining.toLocaleString("ru-RU")}** из 25 000.`,
    );
  } catch (error) {
    await interaction.editReply(errorText(error));
  }
}

async function pointMemberLabel(guild: Guild, userId: string): Promise<string> {
  const member = await guild.members.fetch(userId).catch(() => null);
  return member ? `${member.displayName} (<@${userId}>)` : `<@${userId}>`;
}

function discordTimestampFromSqlite(value: string): string {
  const timestamp = Date.parse(`${value.replace(" ", "T")}Z`);
  return Number.isFinite(timestamp) ? `<t:${Math.floor(timestamp / 1000)}:f>` : value;
}

async function handlePointsView(interaction: ChatInputCommandInteraction, db: BotDatabase): Promise<void> {
  await interaction.deferReply();
  const guild = interaction.guild;
  if (!guild) return void (await interaction.editReply("Эта команда доступна только на сервере."));
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "balance" || subcommand === "количество") {
    const target = interaction.options.getUser("user", false) ?? interaction.user;
    const balance = db.getPointBalance(guild.id, target.id);
    return void (await interaction.editReply(
      `Баллы куратора <@${target.id}>: **${balance.points.toLocaleString("ru-RU")}**.`,
    ));
  }

  if (subcommand === "top" || subcommand === "топ") {
    const limit = interaction.options.getInteger("limit", false) ?? 10;
    const leaderboard = db.getPointLeaderboard(guild.id, limit);
    if (leaderboard.length === 0) {
      return void (await interaction.editReply("Пока нет выданных баллов."));
    }
    const lines = await Promise.all(
      leaderboard.map(async (entry, index) => {
        const label = await pointMemberLabel(guild, entry.userId);
        return `${index + 1}. ${label} — **${entry.points.toLocaleString("ru-RU")}**`;
      }),
    );
    return void (await interaction.editReply(`**Топ кураторов по баллам**\n${lines.join("\n")}`));
  }

  if (subcommand === "history" || subcommand === "история") {
    const target = interaction.options.getUser("user", false);
    const history = db.getPointHistory(guild.id, 15, target?.id);
    if (history.length === 0) {
      return void (await interaction.editReply("История выдачи баллов пока пуста."));
    }
    const lines = await Promise.all(
      history.map(async (entry) => {
        const issuer = await pointMemberLabel(guild, entry.issuerId);
        const recipient = await pointMemberLabel(guild, entry.recipientId);
        return `${discordTimestampFromSqlite(entry.createdAt)} — ${issuer} → ${recipient}: **+${entry.amount.toLocaleString("ru-RU")}**`;
      }),
    );
    return void (await interaction.editReply(`**История выдачи баллов**\n${lines.join("\n")}`));
  }

  await interaction.editReply("Выберите: количество, топ или история.");
}

async function handleRemoveCompositionRequest(
  interaction: import("discord.js").ModalSubmitInteraction,
  db: BotDatabase,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = interaction.guild;
  if (!guild) return void (await interaction.editReply("Эта форма доступна только на сервере."));
  const settings = db.getSettings(guild.id);
  if (!settings) return void (await interaction.editReply("Сначала настройте бота через `/setup`."));

  const curator = await guild.members.fetch(interaction.user.id);
  if (!isCurator(curator, settings)) {
    return void (await interaction.editReply("Снимать роли состава могут только главный куратор и его заместитель."));
  }

  const targetId = cleanId(interaction.fields.getTextInputValue("target_user_id"));
  if (!DISCORD_ID_PATTERN.test(targetId)) {
    return void (await interaction.editReply("Укажите корректный Discord ID или mention пользователя."));
  }
  const target = await guild.members.fetch(targetId).catch(() => null);
  if (!target) return void (await interaction.editReply("Пользователь с таким ID не найден на сервере."));
  if (target.user.bot) return void (await interaction.editReply("Нельзя снимать роль у Discord-бота."));

  const familyName = interaction.fields.getTextInputValue("family_name").trim();
  if (!familyName) return void (await interaction.editReply("Название семьи обязательно."));
  const actualFamilies = await fetchActualDiscordFamilies(guild);
  const actualFamily = findActualDiscordFamily(actualFamilies, familyName);
  const familyRole = actualFamily?.roles[0];
  if (!actualFamily || !familyRole) {
    return void (await interaction.editReply(`Семья «${familyName}» или её основная роль не найдена на сервере Discord.`));
  }

  await interaction.editReply({
    content:
      `Проверьте действие:\n` +
      `Пользователь: <@${target.id}>\n` +
      `Семья: **${actualFamily.name}**\n\n` +
      "Выберите, какую одну роль снять. Остальные роли, лидерская роль, ранг, семья, категория и каналы не изменяются.",
    components: removeCompositionConfirmationComponents(target.id, familyRole.id),
  });
}

async function confirmRemoveComposition(interaction: ButtonInteraction, db: BotDatabase): Promise<void> {
  const parts = interaction.customId.split(":");
  const composition = parts[2];
  const targetId = parts[3];
  const familyRoleId = parts[4];
  if (
    parts[0] !== "remove" ||
    parts[1] !== "confirm" ||
    (composition !== "senior" && composition !== "junior") ||
    !targetId ||
    !familyRoleId ||
    !DISCORD_ID_PATTERN.test(targetId) ||
    !DISCORD_ID_PATTERN.test(familyRoleId)
  ) {
    return void (await interaction.reply({ content: "Эта кнопка больше не активна.", flags: MessageFlags.Ephemeral }));
  }

  await interaction.deferUpdate();
  const guild = interaction.guild;
  if (!guild) return;
  const settings = db.getSettings(guild.id);
  if (!settings) return void (await interaction.followUp({ content: "Настройка не найдена.", flags: MessageFlags.Ephemeral }));
  const curator = await guild.members.fetch(interaction.user.id);
  if (!isCurator(curator, settings)) {
    return void (await interaction.followUp({ content: "Недостаточно прав куратора.", flags: MessageFlags.Ephemeral }));
  }
  const target = await guild.members.fetch(targetId).catch(() => null);
  if (!target) return void (await interaction.editReply({ content: "Пользователь больше не найден на сервере.", components: [] }));

  const roleId = composition === "senior" ? settings.seniorRoleId : familyRoleId;
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) return void (await interaction.editReply({ content: "Указанная роль больше не найдена.", components: [] }));
  const botMember = await fetchBotMember(guild);
  if (!roleIsUsable(role, botMember)) {
    return void (await interaction.editReply({ content: "Бот не может управлять этой ролью. Поднимите его роль выше.", components: [] }));
  }
  if (!target.roles.cache.has(roleId)) {
    return void (await interaction.editReply({ content: `У пользователя нет роли «${role.name}». Ничего не изменено.`, components: [] }));
  }

  await target.roles.remove(roleId, "Grand Family Bot: снятие роли состава");
  await interaction.editReply({
    content: `Роль «${role.name}» снята с пользователя <@${target.id}>. Остальные роли не изменены.`,
    components: [],
  });
}

type ActualFamilyResources = {
  name: string;
  categories: Array<{ id: string; name: string }>;
  roles: Array<{ id: string; name: string }>;
};

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
}

function normalizeFamilyName(name: string): string {
  return name.trim().replace(/\s+/gu, " ").toLocaleLowerCase("ru");
}

function getOrCreateActualFamily(
  families: Map<string, ActualFamilyResources>,
  name: string,
): ActualFamilyResources {
  const cleanName = name.trim().replace(/\s+/gu, " ");
  const key = normalizeFamilyName(cleanName);
  const existing = families.get(key);
  if (existing) return existing;
  const family: ActualFamilyResources = { name: cleanName, categories: [], roles: [] };
  families.set(key, family);
  return family;
}

function findActualDiscordFamily(
  families: Map<string, ActualFamilyResources>,
  name: string,
): ActualFamilyResources | null {
  return families.get(normalizeFamilyName(name)) ?? null;
}

function discordMessagePages(lines: string[], maxLength = 1_800): string[] {
  const pages: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + line.length + 1 > maxLength) {
      pages.push(current);
      current = "";
    }
    current += current ? `\n${line}` : line;
  }
  if (current) pages.push(current);
  return pages.length > 0 ? pages : ["Discord не вернул данные для отображения."];
}

async function fetchActualDiscordFamilies(guild: Guild): Promise<Map<string, ActualFamilyResources>> {
  const [roles, channels] = await Promise.all([
    guild.roles.fetch(),
    guild.channels.fetch(),
  ]);
  const families = new Map<string, ActualFamilyResources>();

  for (const role of roles.values()) {
    if (role.managed) continue;
    const match = /^Семья\s+(.+)$/u.exec(role.name);
    if (!match) continue;
    const family = getOrCreateActualFamily(families, match[1]);
    family.roles.push({ id: role.id, name: role.name });
  }

  for (const channel of channels.values()) {
    if (!channel || channel.type !== ChannelType.GuildCategory) continue;
    const match = /^.+?\s*\|\s*Семья\s+(?:"(.+)"|(.+))$/u.exec(channel.name);
    const familyName = match?.[1] ?? match?.[2];
    if (!familyName) continue;
    const family = getOrCreateActualFamily(families, familyName);
    family.categories.push({ id: channel.id, name: channel.name });
  }
  return families;
}

async function listActualDiscordFamilies(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guild) {
    await interaction.editReply("Эта команда доступна только на сервере Discord.");
    return;
  }

  const guild = interaction.guild;
  const families = await fetchActualDiscordFamilies(guild);

  const sortedFamilies = [...families.values()].sort((left, right) =>
    left.name.localeCompare(right.name, "ru", { sensitivity: "base" }),
  );
  const lines = [
    `**Актуальный список семей на сервере «${guild.name.replaceAll("`", "'")}»**`,
    "Проверено напрямую в Discord: SQLite в этой проверке не используется.",
    `Найдено семейных наборов: **${sortedFamilies.length}**.`,
    "",
  ];

  if (sortedFamilies.length === 0) {
    lines.push(
      "Не найдены категории или основные роли с форматом `Семья <название>` и `… | Семья \"<название>\"`.",
    );
  } else {
    sortedFamilies.forEach((family, index) => {
      const categories =
        family.categories.length > 0
          ? family.categories
              .map((category) => `${inlineCode(category.name)} (${category.id})`)
              .join(", ")
          : "не найдена";
      const roles =
        family.roles.length > 0
          ? family.roles.map((role) => `${inlineCode(role.name)} (${role.id})`).join(", ")
          : "не найдена";
      lines.push(
        `${index + 1}. **${family.name.replaceAll("`", "'")}**\n` +
          `   • Категория: ${categories}\n` +
          `   • Основная роль: ${roles}`,
      );
    });
  }

  const pages = discordMessagePages(lines);
  await interaction.editReply(pages[0]);
  for (const page of pages.slice(1)) {
    await interaction.followUp({ content: page, flags: MessageFlags.Ephemeral });
  }
}

async function routeInteraction(interaction: Interaction, db: BotDatabase): Promise<void> {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "setup" || interaction.commandName === "настройка") return handleSetup(interaction, db);
    if (interaction.commandName === "panel" || interaction.commandName === "панель") return createPanel(interaction, db);
    if (interaction.commandName === "actual-family-list" || interaction.commandName === "актуальный-список-семей") {
      return listActualDiscordFamilies(interaction);
    }
    if (interaction.commandName === "give-points" || interaction.commandName === "выдача") {
      return handleGivePoints(interaction, db);
    }
    if (interaction.commandName === "points" || interaction.commandName === "баллы") {
      return handlePointsView(interaction, db);
    }
    return void (await interaction.reply({ content: "Неизвестная команда. Запустите `/panel` или `/setup`.", flags: MessageFlags.Ephemeral }));
  }
  if (interaction.isButton()) {
    if (interaction.customId === "setup:continue") {
      return void (await interaction.showModal(setupStageTwoModal()));
    }
    if (interaction.customId === "panel:apply") return void (await interaction.showModal(applicationModal()));
    // Подача для получения роли: Старшего состава/Младшего состава
    // Основная кнопка панели всегда открывает выбор состава.
    const rankButtonAction = rankApplicationButtonAction(interaction.customId);
    if (rankButtonAction === "choose") {
      return void (await interaction.reply({
        content: "Выберите состав для подачи заявления:",
        components: rankApplicationChoiceComponents(),
        flags: MessageFlags.Ephemeral,
      }));
    }

    // Кнопки выбора состава открывают соответствующую форму.
    if (rankButtonAction === "senior" || rankButtonAction === "junior") {
      return void (await interaction.showModal(rankApplicationModal(rankButtonAction)));
    }
    if (interaction.customId === "panel:delete") return void (await interaction.showModal(deleteModal()));
    if (interaction.customId === "panel:transfer") return void (await interaction.showModal(transferModal()));
    if (interaction.customId === "panel:remove-composition") {
      return void (await interaction.showModal(removeCompositionModal()));
    }
    if (interaction.customId === "remove:cancel") {
      return void (await interaction.update({ content: "Действие отменено.", components: [] }));
    }
    if (interaction.customId.startsWith("remove:confirm:")) {
      return confirmRemoveComposition(interaction, db);
    }
    const [scope, action, kind, rawId] = interaction.customId.split(":");
    if (scope !== "review" || !rawId) {
      await interaction.deferUpdate();
      return void (await interaction.followUp({
        content: "Эта кнопка больше не активна. Запустите действие заново.",
        flags: MessageFlags.Ephemeral,
      }));
    }
    const id = Number(rawId);
    if (!Number.isInteger(id)) {
      await interaction.deferUpdate();
      return void (await interaction.followUp({
        content: "Эта кнопка содержит некорректный номер заявки.",
        flags: MessageFlags.Ephemeral,
      }));
    }
    if (action === "approve" && kind === "application") {
      const app = db.getApplication(id);
      if (app?.type === "delete") return approveDelete(interaction, id, db);
      if (app?.type === "rank") return approveRankApplication(interaction, id, db);
      return approveApplication(interaction, id, db);
    }
    if (action === "approve" && kind === "transfer") return approveTransfer(interaction, id, db);
    if (action === "reject" && (kind === "application" || kind === "transfer")) {
      return void (await interaction.showModal(rejectModal(kind, id)));
    }
    return void (await interaction.deferUpdate());
  }
  if (interaction.isModalSubmit()) {
    if (interaction.customId === "setup:stage1") return handleStageOne(interaction, db);
    if (interaction.customId === "setup:stage2") return handleStageTwo(interaction, db);
    if (interaction.customId === "application:create") return startApplication(interaction, db);
    if (
      interaction.customId === rankApplicationModalIds.senior ||
      interaction.customId === rankApplicationModalIds.junior
    ) {
      return startRankApplication(interaction, db);
    }
    if (interaction.customId === "family:transfer") return createTransfer(interaction, db);
    if (interaction.customId === "family:delete") return createDeleteRequest(interaction, db);
    if (interaction.customId === "family:remove-composition") {
      return handleRemoveCompositionRequest(interaction, db);
    }
    const match = /^review:reject:(application|transfer):(\d+)$/.exec(interaction.customId);
    if (match) {
      const id = Number(match[2]);
      if (match[1] === "transfer") return rejectTransfer(interaction, id, db);
      return rejectApplication(interaction, id, db);
    }
    return void (await interaction.reply({ content: "Эта форма больше не поддерживается. Запустите действие заново.", flags: MessageFlags.Ephemeral }));
  }
}

async function registerGuildCommands(client: Client, token: string, guildId: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(client.user!.id, guildId), {
    body: slashCommands,
  });
}

async function registerSlashCommands(client: Client, token: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  const guildIds = [...client.guilds.cache.keys()];

  // Keep commands guild-scoped for immediate availability. Remove stale
  // global commands so an old broken registration cannot leave Unknown command
  // entries in Discord clients.
  await rest.put(Routes.applicationCommands(client.user!.id), { body: [] });
  for (const guildId of guildIds) {
    try {
      await registerGuildCommands(client, token, guildId);
    } catch (error) {
      logger.error({ err: error, guildId }, "Unable to register slash commands for guild");
    }
  }
  logger.info(
    { commands: slashCommands.map((command) => command.name), guildIds },
    "Slash commands registered",
  );
}

async function respondToInteractionError(interaction: Interaction, error: unknown): Promise<void> {
  logger.error({ err: error, interactionId: interaction.id }, "Unhandled interaction error");
  if (!interaction.isRepliable()) return;

  const content = "Не удалось выполнить действие. Попробуйте ещё раз.";
  try {
    if (interaction.deferred) {
      if (interaction.isButton()) {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.editReply(content);
      }
    } else if (interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (replyError) {
    logger.error({ err: replyError, interactionId: interaction.id }, "Unable to acknowledge failed interaction");
  }
}

async function loginWithRetry(client: Client, token: string): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      await client.login(token);
      return;
    } catch (error) {
      attempt += 1;
      const delay = Math.min(60_000, 5_000 * Math.min(attempt, 12));
      logger.error(
        { err: error, attempt, retryInMs: delay },
        "Discord Gateway login failed; retrying",
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export function createDiscordBot(db: BotDatabase): Client {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) throw new Error("DISCORD_BOT_TOKEN is required.");
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  client.once(Events.ClientReady, async (readyClient) => {
    logger.info({ user: readyClient.user.tag }, "Discord client ready");
    try {
      await readyClient.application.fetch();
    } catch (error) {
      logger.warn({ err: error }, "Unable to preload Discord application owner");
    }
    try {
      await registerSlashCommands(readyClient, token);
    } catch (error) {
      logger.error({ err: error }, "Unable to register slash commands");
    }
    logger.info({ guildCount: readyClient.guilds.cache.size }, "Starting Discord panel synchronization");
    for (const guild of readyClient.guilds.cache.values()) {
      try {
        const syncedPanel = await syncPanelForGuild(guild, db, false);
        if (syncedPanel) {
          logger.info(
            { guildId: guild.id, messageId: syncedPanel.messageId, created: syncedPanel.created },
            "Discord panel synchronized on startup",
          );
        }
      } catch (error) {
        logger.error({ err: error, guildId: guild.id }, "Unable to synchronize Discord panel on startup");
      }
    }
  });
  client.on(Events.GuildCreate, (guild) => {
    registerGuildCommands(client, token, guild.id).catch((error) => {
      logger.error({ err: error, guildId: guild.id }, "Unable to register slash commands for new guild");
    });
  });
  client.on(Events.InteractionCreate, (interaction) => {
    routeInteraction(interaction, db).catch((error) => void respondToInteractionError(interaction, error));
  });
  client.on(Events.MessageCreate, (message) => {
    handleEvidence(message, db).catch((error) => logger.error({ err: error }, "Unhandled evidence collection error"));
  });
  client.on("error", (error) => logger.error({ err: error }, "Discord client error"));
  client.on("shardError", (error, shardId) => {
    logger.error({ err: error, shardId }, "Discord Gateway shard error");
  });
  client.on("shardReconnecting", (shardId) => {
    logger.warn({ shardId }, "Discord Gateway reconnecting");
  });
  client.on("shardResume", (shardId, replayedEvents) => {
    logger.info({ shardId, replayedEvents }, "Discord Gateway reconnected");
  });
  client.on("shardDisconnect", (closeEvent, shardId) => {
    const code = closeEvent.code;
    logger.warn(
      { shardId, code, reason: closeEvent.reason },
      "Discord Gateway disconnected",
    );
    const fatalGatewayCodes = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
    if (fatalGatewayCodes.has(code)) {
      logger.error({ shardId, code, reason: closeEvent.reason }, "Fatal Discord Gateway disconnect; exiting for supervisor restart");
      process.exit(1);
    }
  });
  client.on("invalidated", () => {
    logger.fatal("Discord session invalidated; stopping so the process supervisor can restart the bot");
    process.exit(1);
  });
  let notReadySince: number | null = null;
  const gatewayWatchdog = setInterval(() => {
    if (client.isReady()) {
      notReadySince = null;
      return;
    }
    const now = Date.now();
    if (notReadySince === null) notReadySince = now;
    const notReadyFor = now - notReadySince;
    logger.warn({ notReadyForMs: notReadyFor }, "Discord client is not ready; waiting for Gateway reconnect");
    if (notReadyFor >= 3 * 60_000) {
      logger.error("Discord client has been not ready for 3 minutes; exiting for supervisor restart");
      process.exit(1);
    }
  }, 60_000);
  gatewayWatchdog.unref();
  void loginWithRetry(client, token).catch((error) => {
    logger.error({ err: error }, "Discord Gateway supervisor stopped unexpectedly");
    process.exit(1);
  });
  return client;
}
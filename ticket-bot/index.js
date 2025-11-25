import { config } from 'dotenv';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { REST } from '@discordjs/rest';

config();

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  GUILD_ID,
  PARTNER_TICKET_CATEGORY_ID,
  TICKET_STAFF_ROLE_ID,
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  throw new Error('DISCORD_TOKEN and DISCORD_CLIENT_ID must be configured');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
});

const departmentName = 'Partner Aaanvragen';
const preflightQuestions = [
  'Wat is de invite URL van de server?',
  'Hoe oud is de owner van de server?',
];
const partnerChecks = [
  'Heeft uw server minimaal 150 leden?',
  'Is minimaal 1 persoon binnen uw management team 16+?',
  'Is uw server vrij van illegale/criminele en NSFW content?',
  'Bent u bereid onze vertegenwoordiger ook de partner role toe te kennen op uw server?',
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const ticketCommand = new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Maak een nieuw ticket aan')
    .addStringOption((opt) => opt
      .setName('afdeling')
      .setDescription('Kies de gewenste afdeling')
      .setRequired(true)
      .addChoices({ name: departmentName, value: 'partner' }));

  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID), { body: [ticketCommand.toJSON()] });
  } else {
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: [ticketCommand.toJSON()] });
  }
}

function buildBooleanRow(questionId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${questionId}:yes`)
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${questionId}:no`)
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
  );
}

async function askValidationQuestions(interaction, context) {
  const answers = [];

  for (let i = 0; i < partnerChecks.length; i += 1) {
    const question = partnerChecks[i];
    const row = buildBooleanRow(`partner-check-${i}`);
    const reply = await interaction.followUp({
      content: question,
      components: [row],
      ephemeral: true,
    });

    let response;
    try {
      response = await reply.awaitMessageComponent({
        time: 60_000,
        filter: (btn) => btn.user.id === interaction.user.id,
      });
    } catch (err) {
      await interaction.followUp({ content: 'Ticket geannuleerd omdat er niet op tijd is gereageerd.', ephemeral: true });
      return null;
    }

    const isYes = response.customId.endsWith(':yes');
    await response.update({ content: `${question}\nAntwoord: ${isYes ? '✅' : '❌'}`, components: [] });

    if (!isYes) {
      await interaction.followUp({
        content: 'Helaas, je voldoet niet aan de eisen om partner te kunnen worden',
        ephemeral: true,
      });
      return null;
    }

    answers.push({ question, answer: isYes });
  }

  return { ...context, checks: answers };
}

async function createTicket(interaction, context) {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.followUp({ content: 'Tickets kunnen alleen in servers worden gemaakt.', ephemeral: true });
    return;
  }

  const overwrites = [
    { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];

  if (TICKET_STAFF_ROLE_ID) {
    overwrites.push({
      id: TICKET_STAFF_ROLE_ID,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  const channel = await guild.channels.create({
    name: `partner-${interaction.user.username}`.slice(0, 90),
    type: ChannelType.GuildText,
    parent: PARTNER_TICKET_CATEGORY_ID || undefined,
    permissionOverwrites: overwrites,
    reason: `${departmentName} ticket geopend door ${interaction.user.tag}`,
  });

  const embed = new EmbedBuilder()
    .setTitle(`${departmentName} Ticket`)
    .setColor(0x2ecc71)
    .addFields(
      { name: preflightQuestions[0], value: context.invite || 'Niet opgegeven', inline: false },
      { name: preflightQuestions[1], value: context.ownerAge || 'Niet opgegeven', inline: false },
      ...context.checks.map((item) => ({
        name: item.question,
        value: item.answer ? '✅ Ja' : '❌ Nee',
        inline: false,
      })),
    )
    .setFooter({ text: `Aangevraagd door ${interaction.user.tag}` })
    .setTimestamp();

  const mentionParts = [];
  if (TICKET_STAFF_ROLE_ID) mentionParts.push(`<@&${TICKET_STAFF_ROLE_ID}>`);
  mentionParts.push(`<@${interaction.user.id}>`);

  await channel.send({
    content: mentionParts.join(' '),
    embeds: [embed],
  });

  await interaction.followUp({ content: `Ticket geopend: ${channel}`, ephemeral: true });
}

client.once('ready', async () => {
  await registerCommands();
  // eslint-disable-next-line no-console
  console.log(`Ticket bot ingelogd als ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName !== 'ticket') return;
    const afdeling = interaction.options.getString('afdeling');

    if (afdeling !== 'partner') {
      await interaction.reply({ content: 'Alleen de Partner Aaanvragen afdeling is beschikbaar.', ephemeral: true });
      return;
    }

    const modal = new ModalBuilder()
      .setTitle(departmentName)
      .setCustomId('partner-modal')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('invite')
            .setLabel(preflightQuestions[0])
            .setRequired(true)
            .setStyle(TextInputStyle.Short),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('ownerAge')
            .setLabel(preflightQuestions[1])
            .setRequired(true)
            .setStyle(TextInputStyle.Short),
        ),
      );

    await interaction.showModal(modal);
  } else if (interaction.isModalSubmit()) {
    if (interaction.customId !== 'partner-modal') return;

    await interaction.reply({ content: 'Bedankt! Laten we eerst wat controles doen...', ephemeral: true });

    const invite = interaction.fields.getTextInputValue('invite');
    const ownerAge = interaction.fields.getTextInputValue('ownerAge');

    const result = await askValidationQuestions(interaction, { invite, ownerAge });
    if (result) {
      await createTicket(interaction, result);
    }
  }
});

client.login(DISCORD_TOKEN);

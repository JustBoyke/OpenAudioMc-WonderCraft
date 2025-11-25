# WonderCraft Ticket Bot

This Discord bot implements the **Partner Aaanvragen** department workflow:

- `/ticket afdeling:Partner Aaanvragen` shows a modal asking:
  - "Wat is de invite URL van de server?"
  - "Hoe oud is de owner van de server?"
- The requester answers four yes/no validation prompts via ✅ / ❌ buttons. Any ❌ stops the flow with the message `Helaas, je voldoet niet aan de eisen om partner te kunnen worden`.
- If all answers are ✅ a ticket channel is created and an embed records all responses so staff do not need to ask again.

## Configuration
Set the following environment variables before running `npm start` inside `ticket-bot/`:

- `DISCORD_TOKEN`: Bot token.
- `DISCORD_CLIENT_ID`: Application client ID.
- `GUILD_ID` (optional): If provided, commands register in a single guild.
- `PARTNER_TICKET_CATEGORY_ID` (optional): Category to place new partner tickets.
- `TICKET_STAFF_ROLE_ID` (optional): Role that should see new tickets alongside the requester.

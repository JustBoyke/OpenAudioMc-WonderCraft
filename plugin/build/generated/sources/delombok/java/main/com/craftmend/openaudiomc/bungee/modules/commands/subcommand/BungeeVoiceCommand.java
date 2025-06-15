package com.craftmend.openaudiomc.bungee.modules.commands.subcommand;

import com.craftmend.openaudiomc.OpenAudioMc;
import com.craftmend.openaudiomc.generic.commands.interfaces.SubCommand;
import com.craftmend.openaudiomc.generic.commands.objects.Argument;
import com.craftmend.openaudiomc.generic.node.enums.ProxiedCommand;
import com.craftmend.openaudiomc.generic.node.packets.CommandProxyPacket;
import com.craftmend.openaudiomc.generic.proxy.interfaces.UserHooks;
import com.craftmend.openaudiomc.generic.user.User;
import com.craftmend.openaudiomc.spigot.modules.proxy.objects.CommandProxyPayload;

public class BungeeVoiceCommand extends SubCommand {

    /**
     * A simple bungeecord command that forwards the alias command
     * to the underlying spigot server.
     *
     * This is because bungeecord doesn't actually store any server data, and the media service
     * is running on the spigot instance anyway
     */

    public BungeeVoiceCommand() {
        super("voice");
        registerArguments(
                new Argument("extend", "Renew your moderation lease"),
                new Argument("mod", "Toggle moderation mode for voicechat"),
                new Argument("inspect <username>", "Open the moderation menu to view the status of a player or ban them")
        );
    }

    @Override
    public void onExecute(User sender, String[] args) {
        // pass on to the spigot server
         CommandProxyPayload payload = new CommandProxyPayload();
        payload.setExecutor(sender.getUniqueId());
        payload.setArgs(args);
        payload.setProxiedCommand(ProxiedCommand.VOICE);

        OpenAudioMc.resolveDependency(UserHooks.class).sendPacket(sender, new CommandProxyPacket(payload));
    }
}

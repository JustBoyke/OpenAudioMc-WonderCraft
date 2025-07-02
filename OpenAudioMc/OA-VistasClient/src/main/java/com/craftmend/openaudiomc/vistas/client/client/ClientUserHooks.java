package com.craftmend.openaudiomc.vistas.client.client;

import com.craftmend.openaudiomc.OpenAudioMc;
import com.craftmend.openaudiomc.generic.proxy.interfaces.UserHooks;
import com.craftmend.openaudiomc.generic.proxy.messages.StandardPacket;
import com.craftmend.openaudiomc.generic.proxy.models.ProxyNode;
import com.craftmend.openaudiomc.api.user.User;
import com.craftmend.openaudiomc.generic.user.adapters.CommandSenderUserAdapter;
import com.craftmend.openaudiomc.vistas.client.redis.packets.WrappedProxyPacket;
import com.craftmend.openaudiomc.vistas.client.Vistas;
import com.craftmend.openaudiomc.vistas.client.users.VistasUser;
import lombok.SneakyThrows;
import org.bukkit.Bukkit;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.UUID;

public class ClientUserHooks implements UserHooks {

    private UserHooks originalHooks = OpenAudioMc.resolveDependency(UserHooks.class);

    @Override
    public Collection<ProxyNode> getNodes() {
        return new ArrayList<>();
    }

    @Override
    public Collection<User> getOnlineUsers() {
        List<User> users = new ArrayList<>();
        for (Player onlinePlayer : Bukkit.getOnlinePlayers()) {
            users.add(playerToUser(onlinePlayer));
        }
        return users;
    }

    @Override
    @SneakyThrows
    public void sendPacket(User user, StandardPacket standardPacket) {
        OpenAudioMc.getService(VistasRedisClient.class).sendPacket(new WrappedProxyPacket(
                standardPacket,
                Vistas.getInstance().getServerId(),
                user.getUniqueId()
        ));
    }

    @Override
    public User byUuid(UUID uuid) {
        Player player = Bukkit.getPlayer(uuid);
        if (player == null) return null;
        return playerToUser(player);
    }

    @Override
    public User fromCommandSender(CommandSender commandSender) {
        if (commandSender instanceof Player) {
            return byUuid(((Player) commandSender).getUniqueId());
        }
        return new CommandSenderUserAdapter(commandSender);
    }

    private VistasUser playerToUser(Player player) {
        return new VistasUser(player.getName(), player.getUniqueId(), originalHooks.byUuid(player.getUniqueId()));
    }
}

package com.craftmend.openaudiomc.spigot.modules.speakers.menu;

import com.craftmend.openaudiomc.OpenAudioMc;
import com.craftmend.openaudiomc.generic.database.DatabaseService;
import com.craftmend.openaudiomc.spigot.modules.speakers.SpeakerService;
import com.craftmend.openaudiomc.spigot.modules.speakers.objects.ApplicableSpeaker;
import com.craftmend.openaudiomc.spigot.modules.speakers.objects.Speaker;
import com.craftmend.openaudiomc.spigot.services.clicklib.Item;
import com.craftmend.openaudiomc.spigot.services.clicklib.menu.Menu;
import org.bukkit.ChatColor;
import org.bukkit.Material;
import org.bukkit.entity.Player;

public class SelectedSpeakerMenu extends Menu {

    public SelectedSpeakerMenu(Player player, ApplicableSpeaker speaker) {
        super(ChatColor.BLUE + "Editing speaker " + speaker.getSpeaker().getSpeakerId().toString().split("-")[0], 9);

        /**
         * Options:
         *  - Teleport to
         *  - Open settings
         *  - Delete lol
         */

        // teleport
        setItem(2, new Item(Material.ARROW)
            .setName(ChatColor.WHITE + "Teleport")
                .onClick((clicker, item) -> {
                    player.closeInventory();
                    player.teleport(speaker.getLocation().toBukkit().toLocation(player.getWorld()));
                })
        );

        // open settings
        setItem(4, new Item(OpenAudioMc.getService(SpeakerService.class).getPlayerSkullItem())
                .setName(ChatColor.WHITE + "Settings")
                .onClick((clicker, item) -> {
                    new SpeakerMenu(speaker.getSpeaker()).openFor(player);
                })
        );

        setItem(6, new Item(Material.TNT)
                .setName(ChatColor.RED + "Delete")
                .onClick((clicker, item) -> {
                    speaker.getSpeaker().getLocation().toBukkit().getBlock().setType(Material.AIR);
                    OpenAudioMc.getService(SpeakerService.class).unlistSpeaker(speaker.getSpeaker().getLocation());
                    OpenAudioMc.getService(DatabaseService.class)
                            .getRepository(Speaker.class)
                            .delete(speaker.getSpeaker());
                    player.closeInventory();
                })
        );
    }
}

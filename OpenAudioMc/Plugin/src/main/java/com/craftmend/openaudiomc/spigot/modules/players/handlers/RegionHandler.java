package com.craftmend.openaudiomc.spigot.modules.players.handlers;

import com.craftmend.openaudiomc.OpenAudioMc;
import com.craftmend.openaudiomc.generic.client.enums.RtcBlockReason;
import com.craftmend.openaudiomc.generic.client.session.RtcSessionManager;
import com.craftmend.openaudiomc.generic.media.objects.MediaUpdate;
import com.craftmend.openaudiomc.generic.networking.interfaces.NetworkingService;
import com.craftmend.openaudiomc.generic.networking.packets.client.media.PacketClientUpdateMedia;
import com.craftmend.openaudiomc.generic.networking.packets.client.voice.PacketClientBlurVoiceUi;
import com.craftmend.openaudiomc.generic.networking.payloads.client.voice.ClientVoiceBlurUiPayload;
import com.craftmend.openaudiomc.generic.platform.Platform;
import com.craftmend.openaudiomc.generic.storage.enums.StorageKey;
import com.craftmend.openaudiomc.spigot.OpenAudioMcSpigot;
import com.craftmend.openaudiomc.spigot.modules.players.interfaces.ITickableHandler;
import com.craftmend.openaudiomc.spigot.modules.players.objects.SpigotConnection;
import com.craftmend.openaudiomc.spigot.modules.regions.interfaces.IRegion;
import com.craftmend.openaudiomc.generic.networking.packets.client.media.PacketClientDestroyMedia;
import com.google.common.collect.ImmutableList;
import lombok.AllArgsConstructor;
import org.bukkit.entity.Player;

import java.util.ArrayList;
import java.util.List;

@AllArgsConstructor
public class RegionHandler implements ITickableHandler {

    private Player player;
    private SpigotConnection spigotConnection;
    private static final List<IRegion> EMPTY_LIST = ImmutableList.of();

    /**
     * update regions based on the players location
     */
    @Override
    public void tick() {
        if (OpenAudioMcSpigot.getInstance().getRegionModule() != null) {
            //regions are enabled
            List<IRegion> detectedRegions;
            if (StorageKey.SETTINGS_IGNORE_REGIONS_WHILE_IN_VEHICLE.getBoolean() && player.getVehicle() != null) {
                detectedRegions = EMPTY_LIST;
            } else {
                detectedRegions = OpenAudioMcSpigot.getInstance().getRegionModule()
                        .getRegionAdapter().getAudioRegions(player.getLocation());
            }

            List<IRegion> enteredRegions = new ArrayList<>(detectedRegions);
            enteredRegions.removeIf(t -> containsRegion(spigotConnection.getRegions(), t));

            List<IRegion> leftRegions = new ArrayList<>(spigotConnection.getRegions());
            leftRegions.removeIf(t -> containsRegion(detectedRegions, t));

            List<IRegion> takeOverMedia = new ArrayList<>();
            enteredRegions.forEach(entered -> {
                if (!isPlayingRegion(entered)) {
                    spigotConnection.getClientConnection().sendMedia(entered.getMedia());
                } else {
                    takeOverMedia.add(entered);
                    // send an update packet for the newly entered region, as the volume might have changed
                    MediaUpdate mediaUpdate = new MediaUpdate(
                            100,
                            100,
                            entered.getFadeTime(),
                            entered.getVolume(),
                            true,
                            entered.getMedia().getMediaId()
                    );
                    // send the updated packet
                    spigotConnection.getClientConnection().sendPacket(new PacketClientUpdateMedia(mediaUpdate));
                }
            });

            leftRegions.forEach(exited -> {
                if (!containsRegion(takeOverMedia, exited)) {
                    OpenAudioMc.getService(NetworkingService.class).send(spigotConnection.getClientConnection(), new PacketClientDestroyMedia(exited.getMedia().getMediaId(), exited.getProperties().getFadeTimeMs()));
                }
            });

            if (spigotConnection.getClientConnection().getSession().isConnectedToRtc()) {
                // check if the current regions include one or more muted regions
                boolean hasVcMuted = false;
                for (IRegion detectedRegion : detectedRegions) {
                    if (!detectedRegion.getProperties().getAllowsVoiceChat()) {
                        hasVcMuted = true;
                        break;
                    }
                }

                RtcSessionManager manager = spigotConnection.getClientConnection().getRtcSessionManager();

                if (hasVcMuted) {
                    if (!manager.getBlockReasons().contains(RtcBlockReason.IN_DISABLED_REGION)) {
                        // send message
                        OpenAudioMc.getService(NetworkingService.class).send(spigotConnection.getClientConnection(), new PacketClientBlurVoiceUi(new ClientVoiceBlurUiPayload(true)));
                        spigotConnection.getClientConnection().getRtcSessionManager().getBlockReasons().add(RtcBlockReason.IN_DISABLED_REGION);
                        spigotConnection.getClientConnection().getUser().sendMessage(Platform.translateColors(OpenAudioMc.getInstance().getConfiguration().getString(StorageKey.SETTING_VC_ENTERED_MUTED_REGION)));
                    }
                } else {
                    if (manager.getBlockReasons().contains(RtcBlockReason.IN_DISABLED_REGION)) {
                        // send message
                        OpenAudioMc.getService(NetworkingService.class).send(spigotConnection.getClientConnection(), new PacketClientBlurVoiceUi(new ClientVoiceBlurUiPayload(false)));
                        spigotConnection.getClientConnection().getUser().sendMessage(Platform.translateColors(OpenAudioMc.getInstance().getConfiguration().getString(StorageKey.SETTING_VC_LEFT_MUTED_REGION)));
                        spigotConnection.getClientConnection().getRtcSessionManager().getBlockReasons().remove(RtcBlockReason.IN_DISABLED_REGION);
                    }
                }
            }

            spigotConnection.setCurrentRegions(detectedRegions);
        }
    }

    @Override
    public void reset() {
        for (IRegion currentRegions : spigotConnection.getCurrentRegions()) {
            OpenAudioMc.getService(NetworkingService.class).send(spigotConnection.getClientConnection(), new PacketClientDestroyMedia(currentRegions.getMedia().getMediaId()));
        }

        spigotConnection.getClientConnection().getRtcSessionManager().getBlockReasons().remove(RtcBlockReason.IN_DISABLED_REGION);
        spigotConnection.getRegions().clear();
    }

    private boolean containsRegion(List<IRegion> list, IRegion query) {
        for (IRegion r : list) if (query.getMedia().getSource().equals(r.getMedia().getSource())) return true;
        return false;
    }

    private boolean isPlayingRegion(IRegion region) {
        for (IRegion r : spigotConnection.getRegions())
            if (region.getMedia().getSource().equals(r.getMedia().getSource())) return true;
        return false;
    }

}

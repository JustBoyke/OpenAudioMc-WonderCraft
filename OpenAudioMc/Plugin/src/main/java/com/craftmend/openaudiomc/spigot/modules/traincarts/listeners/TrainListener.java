package com.craftmend.openaudiomc.spigot.modules.traincarts.listeners;

import com.bergerkiller.bukkit.tc.controller.MinecartMember;
import com.bergerkiller.bukkit.tc.controller.MinecartMemberStore;
import com.bergerkiller.bukkit.tc.events.GroupRemoveEvent;
import com.craftmend.openaudiomc.OpenAudioMc;
import com.craftmend.openaudiomc.generic.networking.interfaces.NetworkingService;
import com.craftmend.openaudiomc.generic.networking.packets.client.media.PacketClientDestroyMedia;
import com.craftmend.openaudiomc.spigot.modules.players.SpigotPlayerService;
import com.craftmend.openaudiomc.spigot.modules.players.objects.SpigotConnection;
import com.craftmend.openaudiomc.spigot.modules.traincarts.TrainCartsModule;
import com.craftmend.openaudiomc.spigot.modules.traincarts.models.TrainMedia;
import lombok.AllArgsConstructor;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.vehicle.VehicleEnterEvent;
import org.bukkit.event.vehicle.VehicleExitEvent;

@AllArgsConstructor
public class TrainListener implements Listener {

    private TrainCartsModule trainCartsModule;

    @EventHandler
    public void onVehicleDestroy(GroupRemoveEvent event) {
        String trainName = event.getGroup().getProperties().getTrainName();
        trainCartsModule.handleTrainDeletion(trainName);
    }

    @EventHandler
    public void onVehicleEnter(VehicleEnterEvent event) {
        MinecartMember<?> member = MinecartMemberStore.getFromEntity(event.getVehicle());
        if (member == null)
            return;

        if (event.getEntered() instanceof Player) {
            String trainName = member.getGroup().getProperties().getTrainName();
            Player player = (Player) event.getEntered();

            TrainMedia media = trainCartsModule.getMediaFromTrain(trainName);
            if (media == null) return;

            SpigotConnection spigotConnection = OpenAudioMc.getService(SpigotPlayerService.class).getClient(player);
            spigotConnection.getClientConnection().sendMedia(media.toMedia());
        }
    }

    @EventHandler
    public void onVehicleExit(VehicleExitEvent event) {
        MinecartMember<?> member = MinecartMemberStore.getFromEntity(event.getVehicle());
        if (member == null)
            return;

        if (event.getExited() instanceof Player) {
            String trainName = member.getGroup().getProperties().getTrainName();
            Player player = (Player) event.getExited();

            TrainMedia media = trainCartsModule.getMediaFromTrain(trainName);
            if (media == null) return;

            SpigotConnection spigotConnection = OpenAudioMc.getService(SpigotPlayerService.class).getClient(player);
            OpenAudioMc.getService(NetworkingService.class).send(spigotConnection.getClientConnection(), new PacketClientDestroyMedia(media.getMedia().getMediaId().toString()));
        }
    }

}

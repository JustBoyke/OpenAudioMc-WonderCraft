package com.craftmend.openaudiomc.vistas.client.redis.packets;

import com.craftmend.openaudiomc.generic.networking.abstracts.AbstractPacketPayload;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;

import java.util.UUID;

@Getter
@NoArgsConstructor
@AllArgsConstructor
public class UserLeavePacket extends AbstractPacketPayload {

    private String playerName;
    private UUID playerUuid;
    private UUID serverId;

}

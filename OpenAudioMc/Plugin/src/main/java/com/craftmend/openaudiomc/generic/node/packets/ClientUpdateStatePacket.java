package com.craftmend.openaudiomc.generic.node.packets;

import com.craftmend.openaudiomc.OpenAudioMc;
import com.craftmend.openaudiomc.generic.client.objects.ClientConnection;
import com.craftmend.openaudiomc.generic.proxy.messages.PacketWriter;
import com.craftmend.openaudiomc.generic.proxy.messages.StandardPacket;
import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;

import java.io.DataInputStream;
import java.io.IOException;
import java.util.UUID;

@Getter
@NoArgsConstructor
@AllArgsConstructor
public class ClientUpdateStatePacket extends StandardPacket {

    private UUID clientUuid;
    private String streamId;
    private boolean enabled;
    private boolean microphoneEnabled;
    private boolean deafened;
    private String explodedToken;
    private int volume;

    public void handle(DataInputStream dataInputStream) throws IOException {
        ClientUpdateStatePacket self = OpenAudioMc.getGson().fromJson(dataInputStream.readUTF(), ClientUpdateStatePacket.class);
        this.clientUuid = self.getClientUuid();
        this.streamId = self.getStreamId();
        this.enabled = self.isEnabled();
        this.microphoneEnabled = self.isMicrophoneEnabled();
        this.deafened = self.isDeafened();
        this.explodedToken = self.getExplodedToken();
        this.volume = self.getVolume();
    }

    public static ClientUpdateStatePacket of(ClientConnection cc) {
        return new ClientUpdateStatePacket(
            cc.getOwner().getUniqueId(),
            cc.getRtcSessionManager().getStreamKey(),
            cc.getSession().isConnectedToRtc(),
            cc.getRtcSessionManager().isMicrophoneEnabled(),
            cc.getRtcSessionManager().isVoicechatDeafened(),
            cc.getAuth().getStaticToken(),
            cc.getSession().getVolume()
        );
    }

    public PacketWriter write() throws IOException {
        PacketWriter packetWriter = new PacketWriter(this);
        packetWriter.writeUTF(OpenAudioMc.getGson().toJson(this));
        return packetWriter;
    }
}

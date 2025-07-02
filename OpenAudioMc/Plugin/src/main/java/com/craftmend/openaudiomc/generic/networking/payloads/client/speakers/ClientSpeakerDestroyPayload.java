package com.craftmend.openaudiomc.generic.networking.payloads.client.speakers;

import com.craftmend.openaudiomc.generic.networking.abstracts.AbstractPacketPayload;
import com.craftmend.openaudiomc.generic.networking.payloads.client.speakers.objects.ClientSpeaker;
import lombok.AllArgsConstructor;

@AllArgsConstructor
public class ClientSpeakerDestroyPayload extends AbstractPacketPayload {

    private ClientSpeaker clientSpeaker;

}

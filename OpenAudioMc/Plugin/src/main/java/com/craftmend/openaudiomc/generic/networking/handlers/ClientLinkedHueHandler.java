package com.craftmend.openaudiomc.generic.networking.handlers;

import com.craftmend.openaudiomc.generic.networking.abstracts.PayloadHandler;
import com.craftmend.openaudiomc.generic.client.objects.ClientConnection;
import com.craftmend.openaudiomc.generic.networking.interfaces.Authenticatable;
import com.craftmend.openaudiomc.generic.networking.payloads.in.ClientEnabledHuePayload;

public class ClientLinkedHueHandler extends PayloadHandler<ClientEnabledHuePayload> {

    @Override
    public void onReceive(ClientEnabledHuePayload payload) {
        // deprecated
    }
}

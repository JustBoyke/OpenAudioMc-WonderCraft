package com.craftmend.openaudiomc.generic.state.collectors;

import com.craftmend.openaudiomc.OpenAudioMc;
import com.craftmend.openaudiomc.generic.networking.interfaces.NetworkingService;
import com.craftmend.openaudiomc.generic.state.interfaces.StateDetail;

public class ClientCacheDetail implements StateDetail {
    @Override
    public String title() {
        return "Loaded Clients";
    }

    @Override
    public String value() {
        return OpenAudioMc.getService(NetworkingService.class).getClients().size() + "";
    }
}

package com.craftmend.openaudiomc.generic.state.collectors;

import com.craftmend.openaudiomc.OpenAudioMc;
import com.craftmend.openaudiomc.generic.state.interfaces.StateDetail;
import com.craftmend.openaudiomc.spigot.OpenAudioMcSpigot;
import com.craftmend.openaudiomc.spigot.modules.speakers.SpeakerService;

public class SpigotSpeakerDetail implements StateDetail {
    @Override
    public String title() {
        return "Loaded Speakers";
    }

    @Override
    public String value() {
        return OpenAudioMc.getService(SpeakerService.class).getSpeakerMap().size() + "";
    }
}

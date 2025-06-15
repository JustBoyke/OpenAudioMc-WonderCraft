package com.craftmend.openaudiomc.spigot.modules.rules;

import com.craftmend.openaudiomc.OpenAudioMc;
import com.craftmend.openaudiomc.generic.database.DatabaseService;
import com.craftmend.openaudiomc.generic.service.Service;
import com.craftmend.openaudiomc.spigot.OpenAudioMcSpigot;
import com.craftmend.openaudiomc.spigot.modules.rules.data.Rule;
import com.craftmend.openaudiomc.spigot.modules.rules.rules.biome.BiomeRule;
import com.craftmend.openaudiomc.spigot.modules.rules.rules.damage.DamageListener;
import com.craftmend.openaudiomc.spigot.modules.rules.rules.damage.DamageRule;
import com.craftmend.openaudiomc.spigot.modules.rules.rules.time.WorldTimeRule;
import com.craftmend.openaudiomc.spigot.modules.rules.rules.world.WorldRule;
import com.craftmend.openaudiomc.spigot.modules.rules.rules.world.WorldRuleTest;
import com.craftmend.openaudiomc.spigot.modules.rules.storage.MediaRule;
import org.bukkit.Bukkit;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

public class MediaRuleService extends Service {

    private final List<Rule<?>> rules = new ArrayList<>();

    public MediaRuleService() {
        addRule(new WorldRule());
        addRule(new WorldTimeRule());
        addRule(new BiomeRule());

        DamageListener damageListener = new DamageListener();
        addRule(new DamageRule(damageListener));
        Bukkit.getPluginManager().registerEvents(damageListener, OpenAudioMcSpigot.getInstance());
    }

    public void addRule(Rule<?> rule) {
        rules.add(rule);
    }

    public Rule<?> getRuleById(String id) {
        for (Rule<?> rule : rules) {
            if (rule.getId().equals(id)) return rule;
        }
        return null;
    }

}

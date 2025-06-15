package com.craftmend.openaudiomc.generic.utils.data;

import java.util.stream.Stream;

public abstract class Filter<T, V> {

    public abstract Stream<T> wrap(Stream<T> existingStream, V context);
    public abstract void updateProperty(String name, int value);
    protected Filter<T, V> child = null;

    public void addChild(Filter<T, V> extraChild) {
        if (child == null) {
            child = extraChild;
        } else {
            child.addChild(extraChild);
        }
    }
}

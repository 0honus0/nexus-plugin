import type { Component, InjectionKey, Ref } from 'vue';

export const fileListKey: InjectionKey<Readonly<Ref<Component | undefined>>> = Symbol('workspace.fileList');

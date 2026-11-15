// "Ask simplan AI" work item menu action: opens the simplan Chat hub with the composer
// prefilled with "@ai about #<id>: ".

import * as SDK from 'azure-devops-extension-sdk';
import { initPage, hubUrl, navigateTo } from '../common/backend';

let ctxPromise;

SDK.register('simplan-ask-action', {
  execute: async (actionContext) => {
    const ctx = await ctxPromise;
    const c = actionContext || {};
    const id = c.workItemId || c.id || (Array.isArray(c.workItemIds) && c.workItemIds[0])
      || (Array.isArray(c.ids) && c.ids[0]);
    const url = await hubUrl(ctx, 'simplan-chat-hub', id ? { ask: String(id) } : {});
    await navigateTo(url);
  },
});

ctxPromise = initPage().then(async (ctx) => {
  await ctx.SDK.notifyLoadSucceeded();
  return ctx;
});

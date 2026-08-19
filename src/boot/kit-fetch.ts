import { defineBoot } from '#q-app';

// lnurlcash-kit's transport resolves its fetch as `options.fetch ??
// globalThis.fetch` and then invokes it as a method on the options object.
// In a browser, calling window.fetch with any receiver other than window
// throws a synchronous "Illegal invocation" TypeError - before any request
// is even attempted (Node's fetch has no such receiver check, so the unit
// tests never see it; every kit network call failed in real browsers).
// Binding the global once here means the kit's captured default is already
// bound, whichever receiver it is invoked with. Remove once lnurlcash-kit
// fixes this upstream in its transport (resolveOptions).
export default defineBoot(() => {
  window.fetch = window.fetch.bind(window);
});

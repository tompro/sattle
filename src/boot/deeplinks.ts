import { defineBoot } from '#q-app';

import { initDeepLinks } from '@/capabilities/deepLinks';

// Deep-link bootstrap (capabilities/deepLinks.ts): native appUrlOpen /
// cold-start launch URLs and the PWA protocol-handler ?uri= landing all
// funnel into pendingExternalInput; the home screen consumes it and opens
// the matching receive/pay dialog. Every accepted link routes home first -
// the dialogs live there.
export default defineBoot(({ router }) => {
  void initDeepLinks(() => {
    void router.push('/').catch(() => {
      // already on '/' - a redundant navigation is not an error
    });
  });
});

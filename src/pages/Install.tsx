import { isIOS, isStandalone } from '../lib/push';
import { PageHeader, Notice } from '../components/ui';
import { IconShare, IconPlus, IconBell, IconCheck } from '../components/icons';

const steps = [
  { icon: IconShare, title: 'Open in Safari and tap Share', text: 'Open this app’s address in Safari on your iPhone, then tap the Share button (square with an arrow).' },
  { icon: IconPlus, title: 'Add to Home Screen', text: 'Scroll down and choose “Add to Home Screen”, then tap Add. (On iOS 26 sites added this way open as web apps by default.)' },
  { icon: IconCheck, title: 'Open it from the Home Screen icon', text: 'Always launch the app from the new “Attendance” icon and sign in there. It keeps its own sign-in, separate from Safari.' },
  { icon: IconBell, title: 'Turn on notifications', text: 'In the app go to Settings → Notifications → “Enable notifications on this device” and tap Allow. Then use “Send test”.' },
];

export function InstallPage() {
  const standalone = isStandalone();
  return (
    <div className="tabbar-space mx-auto max-w-lg px-4">
      <PageHeader title="Install on iPhone" back="/settings" />
      {standalone && <div className="mb-4"><Notice tone="success">You are using the installed app. You can enable notifications in Settings.</Notice></div>}
      {!isIOS() && !standalone && <div className="mb-4"><Notice>These steps are for iPhone and iPad. On Android or desktop Chrome, use the browser menu → “Install app”.</Notice></div>}
      <ol className="space-y-3">
        {steps.map((s, i) => (
          <li key={s.title} className="card flex gap-4 !p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"><s.icon size={20} /></div>
            <div>
              <div className="font-semibold">{i + 1}. {s.title}</div>
              <p className="mt-1 text-sm leading-relaxed text-zinc-500">{s.text}</p>
            </div>
          </li>
        ))}
      </ol>
      <section className="card mt-5 space-y-2 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
        <h2 className="font-semibold text-zinc-900 dark:text-white">Good to know</h2>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>Requires iOS / iPadOS 16.4 or later. Notifications only work in the Home Screen app, not in a Safari tab.</li>
          <li>Reminders are sent by the server, so they arrive when the app is closed or the phone is locked — as long as the phone has internet.</li>
          <li>Timing is usually within a minute of the scheduled time; Apple’s push service and Focus / Low Power modes can delay or silence it.</li>
          <li>If you delete the Home Screen app, its notification subscription is gone. Re-install and enable notifications again.</li>
          <li>Apple’s support for Home Screen web apps has differed by region at times (for example in the EU). If notifications are unavailable, everything else in the app still works.</li>
          <li>Each device you enable gets its own reminder (iPhone and iPad both, for example).</li>
        </ul>
      </section>
    </div>
  );
}

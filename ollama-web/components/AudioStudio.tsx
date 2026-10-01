"use client";

import { useMemo, useState } from "react";
import { Mic2, Sparkles, Volume2 } from "lucide-react";
import AudioDubber from "@/components/AudioDubber";
import TextToSpeechStudio from "@/components/TextToSpeechStudio";

type StudioTab = "tts" | "dub";

const tabs: Array<{ id: StudioTab; label: string; description: string; icon: typeof Sparkles }> = [
  { id: "tts", label: "Texto → Voz", description: "Gere locução com perfis de voz", icon: Sparkles },
  { id: "dub", label: "Dublar Áudio", description: "Transcreva, traduz e sintetize", icon: Volume2 },
];

export default function AudioStudio() {
  const [activeTab, setActiveTab] = useState<StudioTab>("tts");

  const activeTabLabel = useMemo(
    () => tabs.find((tab) => tab.id === activeTab)?.label ?? tabs[0].label,
    [activeTab]
  );

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6">
      <div className="mx-auto max-w-6xl">
        <div className="rounded-[28px] border border-border-light bg-surface-light-raised p-4 shadow-sm transition-colors duration-200 dark:border-border-dark dark:bg-surface-dark-raised md:p-6">
          <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-ink-muted">
                Studio de áudio
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-ink-light dark:text-ink-dark">
                Fluxo de locução e dublagem
              </h2>
            </div>

            <div className="inline-flex items-center gap-2 rounded-full border border-border-light bg-surface-light px-3 py-1.5 text-xs font-medium text-ink-muted shadow-sm transition-colors duration-200 dark:border-border-dark dark:bg-surface-dark">
              <Mic2 className="h-3.5 w-3.5 text-accent" />
              {activeTabLabel}
            </div>
          </div>

          <div
            role="tablist"
            aria-label="Abas do estúdio de áudio"
            aria-orientation="horizontal"
            className="inline-flex w-full max-w-xl items-center rounded-2xl border border-border-light bg-surface-light-sunken p-1 shadow-inner transition-colors duration-200 dark:border-border-dark dark:bg-surface-dark-sunken"
          >
            {tabs.map(({ id, label, description, icon: Icon }) => {
              const isActive = activeTab === id;
              const panelId = `${id}-panel`;

              return (
                <button
                  key={id}
                  id={`${id}-tab`}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={panelId}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => setActiveTab(id)}
                  className={[
                    "group relative flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-3 text-left transition-all duration-300 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface-light dark:focus-visible:ring-offset-surface-dark",
                    isActive
                      ? "bg-surface-light-raised text-ink-light shadow-sm ring-1 ring-border-light/80 dark:bg-surface-dark-raised dark:text-ink-dark dark:ring-border-dark/80"
                      : "text-ink-muted hover:text-ink-light hover:bg-surface-light/70 dark:hover:text-ink-dark dark:hover:bg-surface-dark/70",
                  ].join(" ")}
                >
                  <Icon
                    className={[
                      "h-4 w-4 transition-all duration-300",
                      isActive ? "scale-110 text-accent" : "text-ink-muted group-hover:text-accent",
                    ].join(" ")}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium leading-tight">{label}</span>
                    <span className="truncate text-[10px] text-ink-muted/90 leading-tight">
                      {description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-6 min-h-[540px] transition-opacity duration-300 ease-out animate-fadeIn">
            {activeTab === "tts" ? (
              <div id="tts-panel" role="tabpanel" aria-labelledby="tts-tab" className="outline-none">
                <TextToSpeechStudio />
              </div>
            ) : (
              <div id="dub-panel" role="tabpanel" aria-labelledby="dub-tab" className="outline-none">
                <AudioDubber />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

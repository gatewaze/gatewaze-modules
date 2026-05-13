/**
 * React context for the personalization host (PuckCanvasEditor).
 *
 * The PersonalizableFieldWrapper reads this to know how to open
 * VariantEditor when the user clicks "Personalize". Host context lives
 * one level up — the canvas editor — so the wrapper never owns variant
 * state.
 */

import * as React from 'react';

export interface PersonalizationHost {
  openVariantEditor(args: { blockInstanceId: string; propName: string }): void;
}

const PersonalizationHostContext = React.createContext<PersonalizationHost | null>(null);

export function PersonalizationHostProvider({
  host,
  children,
}: {
  host: PersonalizationHost;
  children: React.ReactNode;
}) {
  return (
    <PersonalizationHostContext.Provider value={host}>
      {children}
    </PersonalizationHostContext.Provider>
  );
}

export function usePersonalizationHost(): PersonalizationHost | null {
  return React.useContext(PersonalizationHostContext);
}

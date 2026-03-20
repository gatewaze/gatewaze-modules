commit 67779bbc634e29d7f5361c7fecc7f2b89879ddc2
Author: Dan Baker <me@danb.co>
Date:   Fri Mar 20 08:21:48 2026 +0000

    Enhance icon handling and module setup in onboarding process
    
    - Updated the icon mapping logic to handle both function and object types, ensuring robustness in icon rendering.
    - Integrated module context refresh in the onboarding process to immediately reflect changes in navigation items after module setup.
    - Improved route merging logic to handle lazy loading more effectively, enhancing the routing structure.
    
    This commit improves the user experience by ensuring icons are correctly rendered and that the onboarding process reflects module changes promptly.

diff --git a/packages/admin/src/app/navigation/icons.ts b/packages/admin/src/app/navigation/icons.ts
index 142a9ed..0bd1ad0 100644
--- a/packages/admin/src/app/navigation/icons.ts
+++ b/packages/admin/src/app/navigation/icons.ts
@@ -9,7 +9,8 @@ import SettingIcon from "@/assets/dualicons/setting.svg?react";
 // Strips the "Icon" suffix and maps common Lucide-style aliases used by modules.
 const heroIconsByName: Record<string, ElementType> = {};
 for (const [exportName, component] of Object.entries(HeroOutline)) {
-  if (typeof component !== 'function') continue;
+  if (typeof component !== 'function' && typeof component !== 'object') continue;
+  if (!component) continue;
   // e.g. "EnvelopeIcon" → "Envelope"
   const shortName = exportName.replace(/Icon$/, '');
   heroIconsByName[shortName] = component as ElementType;
diff --git a/packages/admin/src/app/pages/onboarding/ModuleSetupStep.tsx b/packages/admin/src/app/pages/onboarding/ModuleSetupStep.tsx
index fc37028..db6e8af 100644
--- a/packages/admin/src/app/pages/onboarding/ModuleSetupStep.tsx
+++ b/packages/admin/src/app/pages/onboarding/ModuleSetupStep.tsx
@@ -2,12 +2,14 @@ import { useState, useEffect, useRef } from "react";
 import { useNavigate } from "react-router";
 import { CheckCircle2, Loader2, AlertCircle, Package } from "lucide-react";
 import { ModuleService } from "@/utils/moduleService";
+import { useModulesContext } from "@/app/contexts/modules/context";
 import PixelTrail from "@/components/shared/PixelTrail";
 
 type SetupStatus = "running" | "done" | "error";
 
 export default function ModuleSetupStep() {
   const navigate = useNavigate();
+  const { refresh: refreshModulesContext } = useModulesContext();
   const [status, setStatus] = useState<SetupStatus>("running");
   const [statusText, setStatusText] = useState("Preparing modules...");
   const [errorMessage, setErrorMessage] = useState("");
@@ -37,6 +39,9 @@ export default function ModuleSetupStep() {
         );
         setStatus("done");
 
+        // Refresh module context so nav items appear immediately
+        await refreshModulesContext();
+
         // Update onboarding step via API (service_role) to bypass RLS
         const apiUrl = import.meta.env.VITE_API_URL ?? "";
         await fetch(`${apiUrl}/api/modules/settings`, {
diff --git a/packages/admin/src/app/router/moduleRoutes.tsx b/packages/admin/src/app/router/moduleRoutes.tsx
index 841fa01..672627d 100644
--- a/packages/admin/src/app/router/moduleRoutes.tsx
+++ b/packages/admin/src/app/router/moduleRoutes.tsx
@@ -75,10 +75,13 @@ function collectRoutes(guardFilter: string | undefined): RouteObject[] {
       // Merge children if we already have a route for this top-level path
       const existing = topLevel.get(topPath);
       if (existing) {
-        existing.children = [
-          ...(existing.children ?? []),
-          ...(routeObj.children ?? []),
-        ];
+        // If the new route has children, merge them in
+        if (routeObj.children) {
+          existing.children = [
+            ...(existing.children ?? []),
+            ...routeObj.children,
+          ];
+        }
         // If the new route has a lazy loader but no children, it's an index route
         if (routeObj.lazy && !routeObj.children) {
           existing.children = [
@@ -86,6 +89,16 @@ function collectRoutes(guardFilter: string | undefined): RouteObject[] {
             { index: true, lazy: routeObj.lazy },
           ];
         }
+        // If the existing route had lazy (was first registered as a single-segment
+        // path), convert it to an index child so the parent becomes a pathless
+        // wrapper instead of a layout that swallows child renders.
+        if (existing.lazy) {
+          existing.children = [
+            { index: true, lazy: existing.lazy },
+            ...(existing.children ?? []),
+          ];
+          delete existing.lazy;
+        }
       } else {
         topLevel.set(topPath, routeObj);
       }

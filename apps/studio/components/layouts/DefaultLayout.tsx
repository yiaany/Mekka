import { useBreakpoint, useParams } from "common";
import { useRouter } from "next/router";
import { PropsWithChildren, useEffect } from "react";
import {
  ResizablePanel,
  ResizablePanelGroup,
  SidebarProvider,
  usePanelRef,
} from "ui";
import { SkipToContent } from "ui-patterns/SkipToContent";

import { BannerStack } from "../ui/BannerStack/BannerStack";
import { LayoutHeader } from "./Navigation/LayoutHeader/LayoutHeader";
import MobileNavigationBar from "./Navigation/NavigationBar/MobileNavigationBar";
import { MobileSheetProvider } from "./Navigation/NavigationBar/MobileSheetContext";
import { StudioMobileSheetNav } from "./Navigation/NavigationBar/StudioMobileSheetNav";
import { LayoutSidebar } from "./ProjectLayout/LayoutSidebar";
import {
  LayoutSidebarProvider,
  SIDEBAR_KEYS,
} from "./ProjectLayout/LayoutSidebar/LayoutSidebarProvider";
import { ProjectContextProvider } from "./ProjectLayout/ProjectContext";
import { AppBannerWrapper } from "@/components/interfaces/App/AppBannerWrapper";
import { Sidebar } from "@/components/interfaces/Sidebar";
import { useSyncScopedIntrospection } from "@/data/scoped-introspection";
import { useLastVisitedOrganization } from "@/hooks/misc/useLastVisitedOrganization";
import { useCheckLatestDeploy } from "@/hooks/use-check-latest-deploy";
import { IS_PLATFORM } from "@/lib/constants";
import { useAppStateSnapshot } from "@/state/app-state";
import { useSidebarManagerSnapshot } from "@/state/sidebar-manager-state";

export interface DefaultLayoutProps {
  headerTitle?: string;
  hideMobileMenu?: boolean;
}

/**
 * Base layout for all project pages in the dashboard, rendered as the first child on all page files within a project.
 *
 * A second layout as the child to this is required, and the layout depends on which section of the dashboard the page is on. (e.g Auth - AuthLayout)
 *
 * The base layout handles rendering the following UI components:
 * - App banner (e.g for notices or incidents)
 * - Mobile navigation bar
 * - First level side navigation bar (e.g For navigating to Table Editor, SQL Editor, Database page, etc)
 */
export const DefaultLayout = ({
  children,
  headerTitle,
  hideMobileMenu,
}: PropsWithChildren<DefaultLayoutProps>) => {
  useSyncScopedIntrospection();
  useCheckLatestDeploy();

  const { ref } = useParams();
  const router = useRouter();
  const panelRef = usePanelRef();
  const isMobile = useBreakpoint("md");
  const appSnap = useAppStateSnapshot();
  const { isMaximised, activeSidebar } = useSidebarManagerSnapshot();
  const { lastVisitedOrganization } = useLastVisitedOrganization();

  const backToDashboardURL = router.pathname.startsWith("/account")
    ? appSnap.lastRouteBeforeVisitingAccountPage.length > 0
      ? appSnap.lastRouteBeforeVisitingAccountPage
      : IS_PLATFORM && !!lastVisitedOrganization
        ? `/org/${lastVisitedOrganization}`
        : IS_PLATFORM
          ? "/organizations"
          : "/project/local/editor"
    : undefined;

  const contentMinSizePercentage = 50;
  const contentMaxSizePercentage = 70;
  // Persist panel sizes independently because the sidebar is conditionally removed on small screens.
  const layoutSaveId =
    activeSidebar?.component !== undefined && !isMobile
      ? "default-layout-content-with-sidebar"
      : "default-layout-content-content-only";

  useEffect(() => {
    if (!panelRef.current || !activeSidebar || isMobile) return;
    if (isMaximised) {
      panelRef.current.collapse();
    } else {
      panelRef.current.resize(`${contentMaxSizePercentage}%`);
    }
  }, [isMaximised, panelRef, activeSidebar, isMobile]);

  return (
    <SidebarProvider defaultOpen={false}>
      <LayoutSidebarProvider>
        <ProjectContextProvider projectRef={ref}>
          <MobileSheetProvider>
            <div className="flex flex-col h-screen w-screen">
              <SkipToContent href="#main" />
              {/* Top Banner */}
              <AppBannerWrapper />
              <div className="shrink-0">
                {isMobile && (
                  <MobileNavigationBar
                    hideMobileMenu={hideMobileMenu}
                    backToDashboardURL={backToDashboardURL}
                  />
                )}
                <LayoutHeader
                  headerTitle={headerTitle}
                  backToDashboardURL={backToDashboardURL}
                />
              </div>
              {/* Main Content Area */}
              <div className="flex flex-1 w-full overflow-y-hidden">
                {/* Sidebar - Only show for project pages, not account pages */}
                {!router.pathname.startsWith("/account") && <Sidebar />}
                {/* Main Content with Layout Sidebar */}
                <ResizablePanelGroup
                  key={layoutSaveId}
                  orientation="horizontal"
                  className="h-full w-full overflow-x-hidden flex-1 flex flex-row gap-0"
                  autoSaveId={layoutSaveId}
                >
                  <ResizablePanel
                    id="panel-content"
                    className="w-full"
                    panelRef={panelRef}
                    collapsible={
                      activeSidebar?.id === SIDEBAR_KEYS.AI_ASSISTANT
                    }
                    minSize={`${contentMinSizePercentage}`}
                    maxSize={`${contentMaxSizePercentage}`}
                    defaultSize={`${contentMaxSizePercentage}`}
                  >
                    <main
                      id="main"
                      tabIndex={-1}
                      className="h-full overflow-y-auto outline-hidden"
                    >
                      {children}
                    </main>
                  </ResizablePanel>
                  <LayoutSidebar
                    minSize={`${100 - contentMaxSizePercentage}`}
                    maxSize="100"
                    defaultSize={`${100 - contentMaxSizePercentage}`}
                  />
                </ResizablePanelGroup>
              </div>
            </div>

            <BannerStack />
            <StudioMobileSheetNav />
          </MobileSheetProvider>
        </ProjectContextProvider>
      </LayoutSidebarProvider>
    </SidebarProvider>
  );
};

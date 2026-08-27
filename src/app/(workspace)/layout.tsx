import { Workbench } from "@/components/workbench/workbench";

export default function WorkspaceLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <Workbench />
      {children}
    </>
  );
}

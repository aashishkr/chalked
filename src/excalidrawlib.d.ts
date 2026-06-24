// Type declaration for bundled Excalidraw library files (.excalidrawlib)
declare module "*.excalidrawlib" {
  interface LibraryItem {
    id: string;
    status: "published" | "unpublished";
    elements: unknown[];
    created: number;
    name?: string;
  }
  interface ExcalidrawLib {
    type: "excalidrawlib";
    version: number;
    source?: string;
    libraryItems?: LibraryItem[]; // v2 format
    library?: LibraryItem[];      // v1 format (legacy)
  }
  const value: ExcalidrawLib;
  export default value;
}

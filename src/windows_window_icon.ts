import { dirname, join } from "node:path";

const IMAGE_ICON = 1;
const LR_LOADFROMFILE = 0x10;
const WM_SETICON = 0x80;
const ICON_SMALL = 0n;
const ICON_BIG = 1n;
const SM_CXICON = 11;
const SM_CYICON = 12;
const SM_CXSMICON = 49;
const SM_CYSMICON = 50;

export function setWindowsWindowIcon(title: string): () => void {
  if (Deno.build.os !== "windows") return () => {};
  const systemRoot = Deno.env.get("SystemRoot");
  if (!systemRoot) throw new Error("SystemRoot is unavailable");
  const user32 = Deno.dlopen(
    join(systemRoot, "System32", "user32.dll"),
    {
      DestroyIcon: { parameters: ["pointer"], result: "bool" },
      FindWindowW: { parameters: ["pointer", "buffer"], result: "pointer" },
      GetSystemMetrics: { parameters: ["i32"], result: "i32" },
      GetWindowThreadProcessId: {
        parameters: ["pointer", "buffer"],
        result: "u32",
      },
      LoadImageW: {
        parameters: ["pointer", "buffer", "u32", "i32", "i32", "u32"],
        result: "pointer",
      },
      SendMessageW: {
        parameters: ["pointer", "u32", "usize", "pointer"],
        result: "isize",
      },
    } as const,
  );

  let large: Deno.PointerValue = null;
  let small: Deno.PointerValue = null;
  try {
    const window = user32.symbols.FindWindowW(null, wideString(title));
    if (window === null) throw new Error("Native window was not found");
    const processId = new Uint32Array(1);
    user32.symbols.GetWindowThreadProcessId(window, processId);
    if (processId[0] !== Deno.pid) throw new Error("Native window belongs to another process");

    const iconPath = wideString(join(dirname(Deno.execPath()), "AppIcon.ico"));
    large = user32.symbols.LoadImageW(
      null,
      iconPath,
      IMAGE_ICON,
      user32.symbols.GetSystemMetrics(SM_CXICON),
      user32.symbols.GetSystemMetrics(SM_CYICON),
      LR_LOADFROMFILE,
    );
    small = user32.symbols.LoadImageW(
      null,
      iconPath,
      IMAGE_ICON,
      user32.symbols.GetSystemMetrics(SM_CXSMICON),
      user32.symbols.GetSystemMetrics(SM_CYSMICON),
      LR_LOADFROMFILE,
    );
    if (large === null || small === null) throw new Error("AppIcon.ico could not be loaded");
    user32.symbols.SendMessageW(window, WM_SETICON, ICON_BIG, large);
    user32.symbols.SendMessageW(window, WM_SETICON, ICON_SMALL, small);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      user32.symbols.SendMessageW(window, WM_SETICON, ICON_BIG, null);
      user32.symbols.SendMessageW(window, WM_SETICON, ICON_SMALL, null);
      user32.symbols.DestroyIcon(large);
      user32.symbols.DestroyIcon(small);
      user32.close();
    };
  } catch (error) {
    if (large !== null) user32.symbols.DestroyIcon(large);
    if (small !== null) user32.symbols.DestroyIcon(small);
    user32.close();
    throw error;
  }
}

function wideString(value: string): Uint16Array {
  const buffer = new Uint16Array(value.length + 1);
  for (let index = 0; index < value.length; index++) buffer[index] = value.charCodeAt(index);
  return buffer;
}

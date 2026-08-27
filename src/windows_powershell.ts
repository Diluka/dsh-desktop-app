// Windows-only: prefer PowerShell 7 (pwsh) when the user has it installed. The
// AI toolchain (dsh/npx/node) works reliably on pwsh but frequently fights
// Windows PowerShell 5.1 (encoding and behavioral quirks). pwsh must be
// installed by the user; powershell.exe (5.1) is the built-in fallback.

let preferredCommand = "powershell.exe";
let detected = false;

export interface WindowsPowershellStatus {
  readonly pwshAvailable: boolean;
  readonly command: string;
}

/** The PowerShell executable used to run .ps1 shims. Valid after
 * detectWindowsPowershell has run; defaults to the built-in 5.1 otherwise. */
export function windowsPowershellCommand(): string {
  return preferredCommand;
}

/** Probe for PowerShell 7 once and cache which executable to use. */
export async function detectWindowsPowershell(
  probe: (
    command: string,
    args: string[],
  ) => Promise<{ success: boolean; stdout: string; stderr: string }>,
): Promise<WindowsPowershellStatus> {
  if (detected) {
    return { pwshAvailable: preferredCommand === "pwsh.exe", command: preferredCommand };
  }
  detected = true;
  try {
    const output = await probe("pwsh.exe", [
      "-NoProfile",
      "-NoLogo",
      "-Command",
      "$PSVersionTable.PSVersion.ToString()",
    ]);
    if (output.success && output.stdout.trim()) {
      preferredCommand = "pwsh.exe";
      return { pwshAvailable: true, command: "pwsh.exe" };
    }
  } catch {
    // pwsh is not installed; fall back to the built-in PowerShell 5.1.
  }
  preferredCommand = "powershell.exe";
  return { pwshAvailable: false, command: "powershell.exe" };
}

/** Reset the cached detection; used by tests for isolation. */
export function resetWindowsPowershellDetection(): void {
  preferredCommand = "powershell.exe";
  detected = false;
}

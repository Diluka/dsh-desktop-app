// Windows-only: keep spawned process trees alive only as long as this app runs.
// The desktop window closes and the process can exit before the async shutdown
// cleanup finishes (observed on Windows), so relying on taskkill in shutdown is
// not enough. Assigning the child to a job object with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE makes the OS terminate the whole tree
// (e.g. powershell -> node -> node) the moment this process exits, because the
// OS closes every handle owned by the process and that closes the job.

const KILL_ON_JOB_CLOSE = 0x2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
// sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) on x64.
const EXTENDED_LIMIT_INFO_SIZE = 144;
// LimitFlags field offset within JOBOBJECT_BASIC_LIMIT_INFORMATION.
const LIMIT_FLAGS_OFFSET = 16;

function loadKernel32() {
  return Deno.dlopen(
    "kernel32.dll",
    {
      CreateJobObjectW: { parameters: ["pointer", "pointer"], result: "pointer" },
      SetInformationJobObject: { parameters: ["pointer", "i32", "pointer", "u32"], result: "i32" },
      AssignProcessToJobObject: { parameters: ["pointer", "pointer"], result: "i32" },
      OpenProcess: { parameters: ["u32", "i32", "u32"], result: "pointer" },
      CloseHandle: { parameters: ["pointer"], result: "i32" },
    } as const,
  );
}

let kernel32: ReturnType<typeof loadKernel32> | undefined;

function kernel32Api(): ReturnType<typeof loadKernel32> | undefined {
  if (kernel32) return kernel32;
  try {
    kernel32 = loadKernel32();
  } catch {
    return undefined;
  }
  return kernel32;
}

// Job handles are kept referenced for the whole process lifetime. They are only
// closed by the OS when this process exits, which triggers KILL_ON_JOB_CLOSE.
const killOnCloseJobs = new Set<Deno.PointerValue>();

/** Assign a freshly spawned child so the OS kills it and its descendants when
 * this process exits. Returns false when the platform/API is unavailable or the
 * assignment failed; callers keep their existing taskkill fallback. */
export function assignChildToKillOnCloseJob(pid: number | undefined): boolean {
  const api = kernel32Api();
  if (!api || typeof pid !== "number" || pid <= 0) return false;
  try {
    const job = api.symbols.CreateJobObjectW(null, null);
    if (job === null) return false;
    const info = new Uint8Array(EXTENDED_LIMIT_INFO_SIZE);
    new DataView(info.buffer).setUint32(LIMIT_FLAGS_OFFSET, KILL_ON_JOB_CLOSE, true);
    const configured = api.symbols.SetInformationJobObject(
      job,
      JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
      Deno.UnsafePointer.of(info),
      EXTENDED_LIMIT_INFO_SIZE,
    );
    if (!configured) {
      api.symbols.CloseHandle(job);
      return false;
    }
    const process = api.symbols.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
    if (process === null) {
      api.symbols.CloseHandle(job);
      return false;
    }
    const assigned = api.symbols.AssignProcessToJobObject(job, process);
    api.symbols.CloseHandle(process);
    if (!assigned) {
      // No members were assigned, so closing a KILL_ON_JOB_CLOSE job is safe.
      api.symbols.CloseHandle(job);
      return false;
    }
    killOnCloseJobs.add(job);
    return true;
  } catch {
    return false;
  }
}

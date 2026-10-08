// Web edition: the browser shows its own microphone and camera prompt
// when getUserMedia runs. These helpers stay so call sites do not branch.

export function ensureMicrophonePermission(): Promise<boolean> {
    return Promise.resolve(true);
}

export function ensureCameraPermission(): Promise<boolean> {
    return Promise.resolve(true);
}

export function ensureCameraAndMicPermission(): Promise<boolean> {
    return Promise.resolve(true);
}

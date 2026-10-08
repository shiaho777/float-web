// Web edition: downloads go through the browser. There is no public Documents
// permission to request.

export async function hasPublicDocumentsAccess(): Promise<boolean> {
    return true;
}

export async function requestDocumentsAccess(): Promise<boolean> {
    return true;
}

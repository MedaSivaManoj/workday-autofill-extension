import type { ProfileData } from "./types";

const KEY = "profileData";

export async function loadData(): Promise<ProfileData | null> {
  const { profileData } = await chrome.storage.local.get(KEY);
  return profileData ?? null;
}

export async function saveData(data: ProfileData) {
  await chrome.storage.local.set({ [KEY]: data });
}

export async function clearData() {
  await chrome.storage.local.remove(KEY);
}

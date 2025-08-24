import type { ProfileData } from "./types";
import { fallback, randomDateISO, randomEmail, randomPhone, randomString } from "./random";

export function inferSummary(d: ProfileData): string {
  const parts = [];
  if (d.fullName || d.firstName || d.lastName) parts.push(`Name: ${d.fullName ?? [d.firstName, d.lastName].filter(Boolean).join(" ")}`);
  if (d.email) parts.push(`Email: ${d.email}`);
  if (d.phoneNumber) parts.push(`Phone: ${d.phoneNumber}`);
  if (d.workExperiences?.length) parts.push(`Work: ${d.workExperiences.length} entries`);
  if (d.educationExperiences?.length) parts.push(`Education: ${d.educationExperiences.length} entries`);
  return parts.join("\n");
}

export function canonicalProfile(d: ProfileData) {
  // Provide safe fallbacks for critical fields
  return {
    ...d,
    email: fallback(d.email, randomEmail),
    phoneNumber: fallback(d.phoneNumber, randomPhone),
    DoB: fallback(d.DoB, () => randomDateISO(1980, 2004)),
    firstName: fallback(d.firstName, () => "John"),
    lastName: fallback(d.lastName, () => "Doe"),
    address1: fallback(d.address1, () => `${Math.floor(Math.random()*999)} ${randomString(6)} St`),
    city: fallback(d.city, () => "San Francisco"),
    state: fallback(d.state, () => "CA"),
    zip: fallback(d.zip, () => "94105"),
    country: fallback(d.country, () => "United States")
  };
}

// Heuristic label keywords → profile keys
export const FIELD_HINTS: Record<string, (keyof ProfileData)[]> = {
  "first name": ["firstName", "preferredName"],
  "given name": ["firstName"],
  "middle name": ["middleName"],
  "last name": ["lastName", "familyName"],
  "surname": ["lastName"],
  "preferred": ["preferredName"],
  "preferred name": ["hasPreferredName"],
  "have a preferred": ["hasPreferredName"],
  "full name": ["fullName"],
  "email": ["email"],
  "phone": ["phoneNumber"],
  "mobile": ["phoneNumber"],
  "address line 1": ["address1", "street"],
  "address line 2": ["address2", "apartment", "building", "floor"],
  "city": ["city"],
  "state": ["state"],
  "province": ["state"],
  "zip": ["zip"],
  "postal": ["zip"],
  "country": ["country"],
  "date of birth": ["DoB"],
  "dob": ["DoB"],
  "linkedin": ["linkedinUrl"],
  "github": ["githubUrl"],
  "twitter": ["twitterUrl"],
  "nationality": ["nationality"],
  "marital": ["maritalStatus"],
  "gender": ["gender"],
  "how did you hear": ["howDidYouHearAboutUs"],
  "hear about us": ["howDidYouHearAboutUs"],
  "referral source": ["howDidYouHearAboutUs"],
  "previously worked": ["previouslyWorkedForCompany"],
  "worked for": ["previouslyWorkedForCompany"],
  "employee or contractor": ["previouslyWorkedForCompany"]
};

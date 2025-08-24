export function randomString(len = 8) {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i=0; i<len; i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

export function randomDigits(len = 6) {
  let s = "";
  for (let i=0; i<len; i++) s += String(Math.floor(Math.random()*10));
  return s;
}

export function randomPhone() {
  return "+1" + randomDigits(10);
}

export function randomEmail() {
  return `${randomString(6)}.${randomString(5)}@example.com`;
}

export function randomDateISO(startYear=1980, endYear=2004) {
  const start = new Date(startYear, 0, 1).getTime();
  const end = new Date(endYear, 11, 31).getTime();
  const d = new Date(start + Math.random()*(end-start));
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function fallback(value: any, generator: ()=>string) {
  if (value === undefined || value === null || value === "") return generator();
  return value;
}

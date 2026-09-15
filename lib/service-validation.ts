export function validateService(input: { name: string; duration: string; price: string; description: string; active: boolean }) {
  const name = input.name.trim();
  const duration = input.duration.trim() ? Number(input.duration) : null;
  const price = input.price.trim() ? Number(input.price) : null;
  if (!name || name.length > 200) throw new Error("Enter a service name (up to 200 characters).");
  if (duration !== null && (!Number.isSafeInteger(duration) || duration <= 0 || duration > 1440)) throw new Error("Duration must be a whole number from 1 to 1440 minutes.");
  if (price !== null && (!Number.isFinite(price) || price < 0)) throw new Error("Price must be a nonnegative number.");
  return { name, duration_minutes: duration, price, description: input.description.trim() || null, is_active: input.active };
}

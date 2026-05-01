import { resolveBusinessTimeZone } from "../lib/timezone";
import { usersService } from "./usersService";

export const businessTimeZoneService = {
  async getForUser(userId: string): Promise<string> {
    const user = await usersService.getById(userId);
    return resolveBusinessTimeZone(user);
  }
};

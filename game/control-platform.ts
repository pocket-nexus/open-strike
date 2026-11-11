import { hasFeature } from "@pocketjs/framework/platform";
/** Hosts with a primary touchscreen and no physical gameplay buttons. */
export const PRIMARY_TOUCH =
  hasFeature("input.touch") && !hasFeature("input.buttons");

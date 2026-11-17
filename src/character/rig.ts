// The soldier's skeleton: the proportions the game poses with (src/soldiers.ts) and the model is sculpted to
// (tools/characters/operator.ts). Metres. One body: change a number here and both follow.
//
// A soldier is fifteen rigid parts. Each part's model has its origin at the joint it turns about, +X to the
// soldier's right, +Y up, +Z to the back when the soldier stands at rest; a limb hangs down -Y from its joint.

export const RIG = {
  /** The pelvis' origin above the feet, standing; how far a full crouch lowers it. */
  hip: 0.95,
  crouch: 0.34,
  /** The hip joints, from the pelvis' origin: to the side, up. */
  hipJoint: [0.1, -0.03],
  /** The waist (where the chest turns on the pelvis), above the pelvis' origin. */
  waist: 0.08,
  /** From the waist along the chest: the neck (where the head turns), the shoulders (to the side, up). */
  neck: 0.54,
  shoulder: [0.185, 0.45],
  /** The centre of the head above the neck. */
  head: 0.115,
  /** Bone lengths: shoulder to elbow, elbow to wrist, hip to knee, knee to ankle; the ankle above the sole. */
  upper: 0.29,
  fore: 0.27,
  thigh: 0.44,
  shin: 0.43,
  ankle: 0.085,
  /** Half the width of the stance. */
  stance: 0.11,
} as const;

/** The parts of a soldier's model, in the order they are placed. */
export const PARTS = ["pelvis", "chest", "head", "upper_r", "upper_l", "fore_r", "fore_l", "hand_r", "hand_l", "thigh_r", "thigh_l", "shin_r", "shin_l", "foot_r", "foot_l"] as const;
export type PartName = (typeof PARTS)[number];

/** The outfits the model comes in: one for each team, one for a soldier of no team. */
export const OUTFITS = ["ember", "azure", "ranger"] as const;
export type Outfit = (typeof OUTFITS)[number];

/** The model file, and the name of a part's node in it for an outfit. */
export const OPERATOR_MODEL = "assets/characters/operator.glb";
export const partNode = (part: PartName, outfit: Outfit): string => `${part}.${outfit}`;

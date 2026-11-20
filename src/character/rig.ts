// The soldier's skeleton: the proportions the game poses with (src/soldiers.ts) and the model is sculpted to
// (tools/characters/operator.ts). Metres. One body: change a number here and both follow.
//
// A soldier has fifteen parts, each with its own frame: the origin at the joint it turns about, +X to the soldier's
// right, +Y up, +Z to the back when the soldier stands at rest; a limb hangs down -Y from its joint. The game works
// out a frame for every part each frame. The clothed body is one skinned mesh over the parts of `SKELETON` (its
// joints are those frames: the cloth bends at the joints); the gear on a part (the helmet, the plate carrier, the
// pads, the gloves, the boots) is rigid, a model of its own placed at the part's frame.

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

/** The skinned body's joints, each with its parent (the root's is null): nodes of the model named as the parts. */
export const SKELETON = {
  pelvis: null, chest: "pelvis", head: "chest",
  upper_r: "chest", upper_l: "chest", fore_r: "upper_r", fore_l: "upper_l",
  thigh_r: "pelvis", thigh_l: "pelvis", shin_r: "thigh_r", shin_l: "thigh_l",
} as const satisfies Partial<Record<PartName, PartName | null>>;
export type JointName = keyof typeof SKELETON;
export const JOINTS = Object.keys(SKELETON) as JointName[];

/** The outfits the model comes in: one for each team, one for a soldier of no team. */
export const OUTFITS = ["ember", "azure", "ranger"] as const;
export type Outfit = (typeof OUTFITS)[number];

/** The model file; the skinned body's node in it for an outfit, and a part's gear's. */
export const OPERATOR_MODEL = "assets/characters/operator.glb";
export const bodyNode = (outfit: Outfit): string => `body.${outfit}`;
export const partNode = (part: PartName, outfit: Outfit): string => `${part}.${outfit}`;

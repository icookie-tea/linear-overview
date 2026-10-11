// Small geometry helpers shared by the corrector.
//
// The extension animates nothing itself: it only *corrects* the geometry the
// shell already allocated, so every box below is either measured from a live
// actor or mapped into the container's coordinate space, never re-derived
// from the shell's interpolation formulas.
import Graphene from 'gi://Graphene';

export const T_EPSILON = 0.005;
export const MIN_SIZE = 1; // px; below that a preview is treated as degenerate

// Box of an actor in stage (screen) coordinates, including the actor's own
// translation/scale and the transforms of all its ancestors.
export function stageBox(actor) {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return {x, y, width, height};
}

// Component-wise linear interpolation. Because every component gets the same
// t, the corners stay on straight lines and the size changes monotonically -
// that is the whole point of the correction.
export function lerpBox(from, to, t) {
    return {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        width: from.width + (to.width - from.width) * t,
        height: from.height + (to.height - from.height) * t,
    };
}

// Drops the corrective transform: pivot back at the top-left, unit scale, no
// translation. (0, 0) is also the pivot the shell leaves behind once a window
// preview's entry animation has finished, see Workspace._doAddWindow().
export function resetTransform(actor) {
    actor.set_pivot_point(0, 0);
    actor.set_scale(1, 1);
    actor.translation_x = 0;
    actor.translation_y = 0;
}

// Maps the point (x, y), given in the coordinate space of the actor's parent,
// to the stage. A layout manager allocates its children *after* the container
// itself was allocated, so the parent chain is already up to date here.
//
// The returned scale is the accumulated scale of that coordinate space, which
// is what turns a stage-space distance into a distance in the parent's space.
export function parentTransform(actor, x, y) {
    const parent = actor.get_parent();
    if (!parent)
        return {origin: {x, y}, scale: {x: 1, y: 1}};

    const origin = parent.apply_relative_transform_to_point(
        null, new Graphene.Point3D({x, y, z: 0}));
    const unit = parent.apply_relative_transform_to_point(
        null, new Graphene.Point3D({x: x + 1, y: y + 1, z: 0}));

    return {
        origin: {x: origin.x, y: origin.y},
        scale: {x: unit.x - origin.x, y: unit.y - origin.y},
    };
}

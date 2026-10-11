// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 icookie-tea
// Geometry shared by the native layout and legacy transform engines.
// Native targets are calculated from the final layout; closing snapshots and
// legacy endpoints are measured from actors. Both interpolate in stage space.
import Graphene from 'gi://Graphene';

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

// Restore exactly the transform we replaced, including its original pivot.
export function captureTransform(actor) {
    const [pivotX, pivotY] = actor.get_pivot_point();
    return {pivotX, pivotY, scaleX: actor.scale_x, scaleY: actor.scale_y,
        x: actor.translation_x, y: actor.translation_y};
}

export function restoreTransform(actor, transform) {
    actor.set_pivot_point(transform.pivotX, transform.pivotY);
    actor.set_scale(transform.scaleX, transform.scaleY);
    actor.translation_x = transform.x;
    actor.translation_y = transform.y;
}

// Map the container's local coordinate system, including its own transform,
// into stage space. Use separate axis probes for the axis-aligned shell tree.
export function parentTransform(actor) {
    const origin = actor.apply_relative_transform_to_point(null, new Graphene.Point3D());
    const unitX = actor.apply_relative_transform_to_point(null, new Graphene.Point3D({x: 1}));
    const unitY = actor.apply_relative_transform_to_point(null, new Graphene.Point3D({y: 1}));

    return {
        origin: {x: origin.x, y: origin.y},
        scale: {x: unitX.x - origin.x, y: unitY.y - origin.y},
    };
}

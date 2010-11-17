/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const Clutter = imports.gi.Clutter;
const Gtk = imports.gi.Gtk;
const St = imports.gi.St;
const Lang = imports.lang;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const Tweener = imports.ui.tweener;
const Main = imports.ui.main;

const Params = imports.misc.params;

// Time to scale down to maxDragActorSize
const SCALE_ANIMATION_TIME = 0.25;
// Time to animate to original position on cancel
const SNAP_BACK_ANIMATION_TIME = 0.25;
// Time to animate to original position on success
const REVERT_ANIMATION_TIME = 0.75;

const DragMotionResult = {
    NO_DROP:   0,
    COPY_DROP: 1,
    MOVE_DROP: 2,
    CONTINUE:  3
};

const DRAG_CURSOR_MAP = {
    0: Shell.Cursor.UNSUPPORTED_TARGET,
    1: Shell.Cursor.COPY,
    2: Shell.Cursor.MOVE
};

const DragDropResult = {
    FAILURE:  0,
    SUCCESS:  1,
    CONTINUE: 2
};

let eventHandlerActor = null;
let currentDraggable = null;
let dragMonitors = [];

function _getEventHandlerActor() {
    if (!eventHandlerActor) {
        eventHandlerActor = new Clutter.Rectangle();
        eventHandlerActor.width = 0;
        eventHandlerActor.height = 0;
        Main.uiGroup.add_actor(eventHandlerActor);
        // We connect to 'event' rather than 'captured-event' because the capturing phase doesn't happen
        // when you've grabbed the pointer.
        eventHandlerActor.connect('event',
                                  function(actor, event) {
                                      return currentDraggable._onEvent(actor, event);
                                  });
    }
    return eventHandlerActor;
}

function addDragMonitor(monitor) {
    dragMonitors.push(monitor);
}

function removeMonitor(monitor) {
    for (let i = 0; i < dragMonitors.length; i++)
        if (dragMonitors[i] == monitor) {
            dragMonitors.splice(i, 1);
            return;
        }
}

function _Draggable(actor, params) {
    this._init(actor, params);
}

_Draggable.prototype = {
    _init : function(actor, params) {
        params = Params.parse(params, { manualMode: false,
                                        restoreOnSuccess: false,
                                        dragActorMaxSize: undefined,
                                        dragActorOpacity: undefined });

        this.actor = actor;
        if (!params.manualMode)
            this.actor.connect('button-press-event',
                               Lang.bind(this, this._onButtonPress));

        this.actor.connect('destroy', Lang.bind(this, function() {
            this._actorDestroyed = true;
            if (this._dragInProgress)
                this._cancelDrag(global.get_current_time());
            this.disconnectAll();
        }));
        this._onEventId = null;

        this._restoreOnSuccess = params.restoreOnSuccess;
        this._dragActorMaxSize = params.dragActorMaxSize;
        this._dragActorOpacity = params.dragActorOpacity;

        this._buttonDown = false; // The mouse button has been pressed and has not yet been released.
        this._dragInProgress = false; // The drag has been started, and has not been dropped or cancelled yet.
        this._animationInProgress = false; // The drag is over and the item is in the process of animating to its original position (snapping back or reverting).
    },

    _onButtonPress : function (actor, event) {
        if (event.get_button() != 1)
            return false;

        if (Tweener.getTweenCount(actor))
            return false;

        this._buttonDown = true;
        // special case St.Clickable: grabbing the pointer would mess up the
        // internal state, so we start the drag manually on hover change
        if (this.actor instanceof St.Clickable)
            this.actor.connect('notify::hover',
                               Lang.bind(this, this._onClickableHoverChanged));
        else
            this._grabActor();

        let [stageX, stageY] = event.get_coords();
        this._dragStartX = stageX;
        this._dragStartY = stageY;

        return false;
    },

    _onClickableHoverChanged: function(button) {
        if (button.hover || !button.held)
            return;

        button.fake_release();
        this.startDrag(this._dragStartX, this._dragStartY,
                       global.get_current_time());
    },

    _grabActor: function() {
        Clutter.grab_pointer(this.actor);
        this._onEventId = this.actor.connect('event',
                                             Lang.bind(this, this._onEvent));
    },

    _ungrabActor: function() {
        Clutter.ungrab_pointer();
        this.actor.disconnect(this._onEventId);
        this._onEventId = null;
    },

    _grabEvents: function() {
        Clutter.grab_pointer(_getEventHandlerActor());
        Clutter.grab_keyboard(_getEventHandlerActor());
    },

    _ungrabEvents: function() {
        Clutter.ungrab_pointer();
        Clutter.ungrab_keyboard();
    },

    _onEvent: function(actor, event) {
        // We intercept BUTTON_RELEASE event to know that the button was released in case we
        // didn't start the drag, to drop the draggable in case the drag was in progress, and
        // to complete the drag and ensure that whatever happens to be under the pointer does
        // not get triggered if the drag was cancelled with Esc.
        if (event.type() == Clutter.EventType.BUTTON_RELEASE) {
            this._buttonDown = false;
            if (this._dragInProgress) {
                return this._dragActorDropped(event);
            } else if (this._dragActor != null && !this._animationInProgress) {
                // Drag must have been cancelled with Esc.
                this._dragComplete();
                return true;
            } else {
                // Drag has never started.
                this._ungrabActor();
                return false;
            }
        // We intercept MOTION event to figure out if the drag has started and to draw
        // this._dragActor under the pointer when dragging is in progress
        } else if (event.type() == Clutter.EventType.MOTION) {
            if (this._dragInProgress) {
                return this._updateDragPosition(event);
            } else if (this._dragActor == null) {
                return this._maybeStartDrag(event);
            }
        // We intercept KEY_PRESS event so that we can process Esc key press to cancel
        // dragging and ignore all other key presses.
        } else if (event.type() == Clutter.EventType.KEY_PRESS && this._dragInProgress) {
            let symbol = event.get_key_symbol();
            if (symbol == Clutter.Escape) {
                this._cancelDrag(event.get_time());
                return true;
            }
        }

        return false;
    },

    /**
     * startDrag:
     * @stageX: X coordinate of event
     * @stageY: Y coordinate of event
     * @time: Event timestamp
     *
     * Directly initiate a drag and drop operation from the given actor.
     * This function is useful to call if you've specified manualMode
     * for the draggable.
     */
    startDrag: function (stageX, stageY, time) {
        currentDraggable = this;
        this._dragInProgress = true;

        this.emit('drag-begin', time);
        if (this._onEventId)
            this._ungrabActor();
        this._grabEvents();
        global.set_cursor(Shell.Cursor.IN_DRAG);

        this._dragX = this._dragStartX = stageX;
        this._dragY = this._dragStartY = stageY;

        if (this.actor._delegate && this.actor._delegate.getDragActor) {
            this._dragActor = this.actor._delegate.getDragActor(this._dragStartX, this._dragStartY);
            // Drag actor does not always have to be the same as actor. For example drag actor
            // can be an image that's part of the actor. So to perform "snap back" correctly we need
            // to know what was the drag actor source.
            if (this.actor._delegate.getDragActorSource) {
                this._dragActorSource = this.actor._delegate.getDragActorSource();
                // If the user dragged from the source, then position
                // the dragActor over it. Otherwise, center it
                // around the pointer
                let [sourceX, sourceY] = this._dragActorSource.get_transformed_position();
                let x, y;
                if (stageX > sourceX && stageX <= sourceX + this._dragActor.width &&
                    stageY > sourceY && stageY <= sourceY + this._dragActor.height) {
                    x = sourceX;
                    y = sourceY;
                } else {
                    x = stageX - this._dragActor.width / 2;
                    y = stageY - this._dragActor.height / 2;
                }
                this._dragActor.set_position(x, y);
            } else {
                this._dragActorSource = this.actor;
            }
            this._dragOrigParent = undefined;

            this._dragOffsetX = this._dragActor.x - this._dragStartX;
            this._dragOffsetY = this._dragActor.y - this._dragStartY;
        } else {
            this._dragActor = this.actor;
            this._dragActorSource = undefined;
            this._dragOrigParent = this.actor.get_parent();
            this._dragOrigX = this._dragActor.x;
            this._dragOrigY = this._dragActor.y;
            this._dragOrigScale = this._dragActor.scale_x;

            let [actorStageX, actorStageY] = this.actor.get_transformed_position();
            this._dragOffsetX = actorStageX - this._dragStartX;
            this._dragOffsetY = actorStageY - this._dragStartY;

            // Set the actor's scale such that it will keep the same
            // transformed size when it's reparented to the stage
            let [scaledWidth, scaledHeight] = this.actor.get_transformed_size();
            this.actor.set_scale(scaledWidth / this.actor.width,
                                 scaledHeight / this.actor.height);
        }

        this._dragActor.reparent(this.actor.get_stage());
        this._dragActor.raise_top();
        Shell.util_set_hidden_from_pick(this._dragActor, true);

        this._dragOrigOpacity = this._dragActor.opacity;
        if (this._dragActorOpacity != undefined)
            this._dragActor.opacity = this._dragActorOpacity;

        this._snapBackX = this._dragStartX + this._dragOffsetX;
        this._snapBackY = this._dragStartY + this._dragOffsetY;
        this._snapBackScale = this._dragActor.scale_x;

        if (this._dragActorMaxSize != undefined) {
            let [scaledWidth, scaledHeight] = this._dragActor.get_transformed_size();
            let currentSize = Math.max(scaledWidth, scaledHeight);
            if (currentSize > this._dragActorMaxSize) {
                let scale = this._dragActorMaxSize / currentSize;
                let origScale =  this._dragActor.scale_x;
                let origDragOffsetX = this._dragOffsetX;
                let origDragOffsetY = this._dragOffsetY;

                // The position of the actor changes as we scale
                // around the drag position, but we can't just tween
                // to the final position because that tween would
                // fight with updates as the user continues dragging
                // the mouse; instead we do the position computations in
                // an onUpdate() function.
                Tweener.addTween(this._dragActor,
                                 { scale_x: scale * origScale,
                                   scale_y: scale * origScale,
                                   time: SCALE_ANIMATION_TIME,
                                   transition: 'easeOutQuad',
                                   onUpdate: function() {
                                       let currentScale = this._dragActor.scale_x / origScale;
                                       this._dragOffsetX = currentScale * origDragOffsetX;
                                       this._dragOffsetY = currentScale * origDragOffsetY;
                                       this._dragActor.set_position(this._dragX + this._dragOffsetX,
                                                                    this._dragY + this._dragOffsetY);
                                   },
                                   onUpdateScope: this });
            }
        }
    },

    _maybeStartDrag:  function(event) {
        let [stageX, stageY] = event.get_coords();

        // See if the user has moved the mouse enough to trigger a drag
        let threshold = Gtk.Settings.get_default().gtk_dnd_drag_threshold;
        if ((Math.abs(stageX - this._dragStartX) > threshold ||
             Math.abs(stageY - this._dragStartY) > threshold)) {
                this.startDrag(stageX, stageY, event.get_time());
                this._updateDragPosition(event);
        }

        return true;
    },

    _updateDragPosition : function (event) {
        let [stageX, stageY] = event.get_coords();
        this._dragX = stageX;
        this._dragY = stageY;

        // If we are dragging, update the position
        if (this._dragActor) {
            this._dragActor.set_position(stageX + this._dragOffsetX,
                                         stageY + this._dragOffsetY);

            let target = this._dragActor.get_stage().get_actor_at_pos(Clutter.PickMode.ALL,
                                                                      stageX, stageY);

            // We call observers only once per motion with the innermost
            // target actor. If necessary, the observer can walk the
            // parent itself.
            let dragEvent = {
                x: stageX,
                y: stageY,
                dragActor: this._dragActor,
                source: this.actor._delegate,
                targetActor: target
            };
            for (let i = 0; i < dragMonitors.length; i++) {
                let motionFunc = dragMonitors[i].dragMotion;
                if (motionFunc) {
                    let result = motionFunc(dragEvent);
                    if (result != DragMotionResult.CONTINUE) {
                        global.set_cursor(DRAG_CURSOR_MAP[result]);
                        return true;
                    }
                }
            }
            while (target) {
                if (target._delegate && target._delegate.handleDragOver) {
                    let [r, targX, targY] = target.transform_stage_point(stageX, stageY);
                    // We currently loop through all parents on drag-over even if one of the children has handled it.
                    // We can check the return value of the function and break the loop if it's true if we don't want
                    // to continue checking the parents.
                    let result = target._delegate.handleDragOver(this.actor._delegate,
                                                                 this._dragActor,
                                                                 targX,
                                                                 targY,
                                                                 event.get_time());
                    if (result != DragMotionResult.CONTINUE) {
                        global.set_cursor(DRAG_CURSOR_MAP[result]);
                        return true;
                    }
                }
                target = target.get_parent();
            }
            global.set_cursor(Shell.Cursor.IN_DRAG);
        }

        return true;
    },

    _dragActorDropped: function(event) {
        let [dropX, dropY] = event.get_coords();
        let target = this._dragActor.get_stage().get_actor_at_pos(Clutter.PickMode.ALL,
                                                                  dropX, dropY);

        // We call observers only once per motion with the innermost
        // target actor. If necessary, the observer can walk the
        // parent itself.
        let dropEvent = {
            dropActor: this._dragActor,
            targetActor: target,
            clutterEvent: event
        };
        for (let i = 0; i < dragMonitors.length; i++) {
            let dropFunc = dragMonitors[i].dragDrop;
            if (dropFunc)
                switch (dropFunc(dropEvent)) {
                    case DragDropResult.FAILURE:
                    case DragDropResult.SUCCESS:
                        return true;
                    case DragDropResult.CONTINUE:
                        continue;
                }
        }

        while (target) {
            if (target._delegate && target._delegate.acceptDrop) {
                let [r, targX, targY] = target.transform_stage_point(dropX, dropY);
                if (target._delegate.acceptDrop(this.actor._delegate,
                                                this._dragActor,
                                                targX,
                                                targY,
                                                event.get_time())) {
                    if (this._actorDestroyed)
                        return true;
                    // If it accepted the drop without taking the actor,
                    // handle it ourselves.
                    if (this._dragActor.get_parent() == this._dragActor.get_stage()) {
                        if (this._restoreOnSuccess) {
                            this._restoreDragActor(event.get_time());
                            return true;
                        } else
                            this._dragActor.destroy();
                    }

                    this._dragInProgress = false;
                    global.unset_cursor();
                    this.emit('drag-end', event.get_time(), true);
                    this._dragComplete();
                    return true;
                }
            }
            target = target.get_parent();
        }

        this._cancelDrag(event.get_time());

        return true;
    },

    // Get position of the drag actor's source if the source is still around,
    // or return the original location if the actor itself was being dragged
    // or the source is no longer around.
    _getRestoreLocation: function() {
        let locX = this._snapBackX;
        let locY = this._snapBackY;

        if (this._dragActorSource && this._dragActorSource.visible)
            [locX, locY] = this._dragActorSource.get_transformed_position();
        return [locX, locY];
    },

    _cancelDrag: function(eventTime) {
        this._dragInProgress = false;
        let [snapBackX, snapBackY] = this._getRestoreLocation();

        if (this._actorDestroyed) {
            global.unset_cursor();
            this.emit('drag-end', eventTime, false);
            return;
        }

        this._animationInProgress = true;
        // No target, so snap back
        Tweener.addTween(this._dragActor,
                         { x: snapBackX,
                           y: snapBackY,
                           scale_x: this._snapBackScale,
                           scale_y: this._snapBackScale,
                           opacity: this._dragOrigOpacity,
                           time: SNAP_BACK_ANIMATION_TIME,
                           transition: 'easeOutQuad',
                           onComplete: this._onAnimationComplete,
                           onCompleteScope: this,
                           onCompleteParams: [this._dragActor, eventTime]
                         });
    },

    _restoreDragActor: function(eventTime) {
        this._dragInProgress = false;
        [restoreX, restoreY] = this._getRestoreLocation();

        // fade the actor back in at its original location
        this._dragActor.set_position(restoreX, restoreY);
        this._dragActor.set_scale(this._snapBackScale, this._snapBackScale);
        this._dragActor.opacity = 0;

        this._animationInProgress = true;
        Tweener.addTween(this._dragActor,
                         { opacity: this._dragOrigOpacity,
                           time: REVERT_ANIMATION_TIME,
                           transition: 'easeOutQuad',
                           onComplete: this._onAnimationComplete,
                           onCompleteScope: this,
                           onCompleteParams: [this._dragActor, eventTime]
                         });
    },

    _onAnimationComplete : function (dragActor, eventTime) {
        if (this._dragOrigParent) {
            dragActor.reparent(this._dragOrigParent);
            dragActor.set_scale(this._dragOrigScale, this._dragOrigScale);
            dragActor.set_position(this._dragOrigX, this._dragOrigY);
        } else {
            dragActor.destroy();
        }
        global.unset_cursor();
        this.emit('drag-end', eventTime, false);

        this._animationInProgress = false;
        if (!this._buttonDown)
            this._dragComplete();
    },

    _dragComplete: function() {
        Shell.util_set_hidden_from_pick(this._dragActor, false);

        this._dragActor = undefined;
        currentDraggable = null;
        this._ungrabEvents();
    }
};

Signals.addSignalMethods(_Draggable.prototype);

/**
 * makeDraggable:
 * @actor: Source actor
 * @params: (optional) Additional parameters
 *
 * Create an object which controls drag and drop for the given actor.
 *
 * If %manualMode is %true in @params, do not automatically start
 * drag and drop on click
 *
 * If %dragActorMaxSize is present in @params, the drag actor will
 * be scaled down to be no larger than that size in pixels.
 *
 * If %dragActorOpacity is present in @params, the drag actor will
 * will be set to have that opacity during the drag.
 *
 * Note that when the drag actor is the source actor and the drop
 * succeeds, the actor scale and opacity aren't reset; if the drop
 * target wants to reuse the actor, it's up to the drop target to
 * reset these values.
 */
function makeDraggable(actor, params) {
    return new _Draggable(actor, params);
}

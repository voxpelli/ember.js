/**
@module @ember/component
*/

import type { InternalFactoryManager } from '@ember/-internals/container/lib/container';
import type { InternalFactory, InternalOwner } from '@ember/-internals/owner';
import { setOwner } from '@ember/-internals/owner';
import { FrameworkObject } from '@ember/object/-internals';
import { getDebugName } from '@ember/-internals/utils';
import { assert } from '@ember/debug';
import { join } from '@ember/runloop';
import type { Arguments, HelperManager } from '@glimmer/interfaces';
import { getInternalHelperManager, helperCapabilities, setHelperManager } from '@glimmer/manager';
import type { DirtyableTag } from '@glimmer/validator';
import { consumeTag, createTag, dirtyTag } from '@glimmer/validator';

export const RECOMPUTE_TAG = Symbol('RECOMPUTE_TAG');

// Signature type utilities
type GetOr<T, K, Else> = K extends keyof T ? T[K] : Else;

type Args<S> = GetOr<S, 'Args', {}>;

type DefaultPositional = unknown[];
type Positional<S> = GetOr<Args<S>, 'Positional', DefaultPositional>;

type Named<S> = GetOr<Args<S>, 'Named', object>;

type Return<S> = GetOr<S, 'Return', unknown>;

// Implements Ember's `Factory` interface and tags it for narrowing/checking.
export interface HelperFactory<T> {
  isHelperFactory: true;
  create(): T;
}

export interface HelperInstance<S> {
  compute(positional: Positional<S>, named: Named<S>): Return<S>;
  destroy(): void;
  [RECOMPUTE_TAG]: DirtyableTag;
}

const IS_CLASSIC_HELPER: unique symbol = Symbol('IS_CLASSIC_HELPER');

export interface SimpleHelper<S> {
  compute: (positional: Positional<S>, named: Named<S>) => Return<S>;
}

// A zero-runtime-overhead private symbol to use in branding the component to
// preserve its type parameter.
declare const SIGNATURE: unique symbol;

/**
  Ember Helpers are functions that can compute values, and are used in templates.
  For example, this code calls a helper named `format-currency`:

  ```app/templates/application.hbs
  <Cost @cents={{230}} />
  ```

  ```app/components/cost.hbs
  <div>{{format-currency @cents currency="$"}}</div>
  ```

  Additionally a helper can be called as a nested helper.
  In this example, we show the formatted currency value if the `showMoney`
  named argument is truthy.

  ```handlebars
  {{if @showMoney (format-currency @cents currency="$")}}
  ```

  Helpers defined using a class must provide a `compute` function. For example:

  ```app/helpers/format-currency.js
  import Helper from '@ember/component/helper';

  export default class extends Helper {
    compute([cents], { currency }) {
      return `${currency}${cents * 0.01}`;
    }
  }
  ```

  Each time the input to a helper changes, the `compute` function will be
  called again.

  As instances, these helpers also have access to the container and will accept
  injected dependencies.

  Additionally, class helpers can call `recompute` to force a new computation.

  @class Helper
  @extends CoreObject
  @public
  @since 1.13.0
*/
// ESLint doesn't understand declaration merging.
/* eslint-disable import/export */
export default interface Helper<S = unknown> {
  /**
    Override this function when writing a class-based helper.

    @method compute
    @param {Array} positional The positional arguments to the helper
    @param {Object} named The named arguments to the helper
    @public
    @since 1.13.0
  */
  compute(positional: Positional<S>, named: Named<S>): Return<S>;
}
export default class Helper<S = unknown> extends FrameworkObject {
  static isHelperFactory = true;
  static [IS_CLASSIC_HELPER] = true;

  // `packages/ember/index.js` was setting `Helper.helper`. This seems like
  // a bad idea and probably not something we want. We've moved that definition
  // here, but it should definitely be reviewed and probably removed.
  /** @deprecated */
  static helper = helper;

  // SAFETY: this is initialized in `init`, rather than `constructor`. It is
  // safe to `declare` like this *if and only if* nothing uses the constructor
  // directly in this class, since nothing else can run before `init`.
  declare [RECOMPUTE_TAG]: DirtyableTag;

  // SAFETY: this has no runtime existence whatsoever; it is a "phantom type"
  // here to preserve the type param.
  private declare [SIGNATURE]: S;

  init(properties: object | undefined) {
    super.init(properties);
    this[RECOMPUTE_TAG] = createTag();

    assert('expected compute to be defined', this.compute);
  }

  /**
    On a class-based helper, it may be useful to force a recomputation of that
    helpers value. This is akin to `rerender` on a component.

    For example, this component will rerender when the `currentUser` on a
    session service changes:

    ```app/helpers/current-user-email.js
    import Helper from '@ember/component/helper'
    import { service } from '@ember/service'
    import { observer } from '@ember/object'

    export default Helper.extend({
      session: service(),

      onNewUser: observer('session.currentUser', function() {
        this.recompute();
      }),

      compute() {
        return this.get('session.currentUser.email');
      }
    });
    ```

    @method recompute
    @public
    @since 1.13.0
  */
  recompute() {
    join(() => dirtyTag(this[RECOMPUTE_TAG]));
  }
}
/* eslint-enable import/export */

export function isClassicHelper(obj: object): boolean {
  return (obj as any)[IS_CLASSIC_HELPER] === true;
}

interface ClassicHelperStateBucket {
  instance: HelperInstance<unknown>;
  args: Arguments;
}

type ClassHelperFactory = InternalFactory<
  HelperInstance<unknown>,
  HelperFactory<HelperInstance<unknown>>
>;

class ClassicHelperManager implements HelperManager<ClassicHelperStateBucket> {
  capabilities = helperCapabilities('3.23', {
    hasValue: true,
    hasDestroyable: true,
  });

  private ownerInjection: Record<string, unknown>;

  constructor(owner: InternalOwner | undefined) {
    let ownerInjection: Record<string, unknown> = {};
    setOwner(ownerInjection, owner!);
    this.ownerInjection = ownerInjection;
  }

  createHelper(
    definition: typeof Helper | InternalFactoryManager<Helper>,
    args: Arguments
  ): ClassicHelperStateBucket {
    let instance = isFactoryManager(definition)
      ? definition.create()
      : definition.create(this.ownerInjection);

    assert(
      'expected HelperInstance',
      (function (instance: unknown): instance is HelperInstance<unknown> {
        if (instance !== null && typeof instance === 'object') {
          let cast = instance as HelperInstance<unknown>;
          return typeof cast.compute === 'function' && typeof cast.destroy === 'function';
        }
        return false;
      })(instance)
    );

    return {
      instance,
      args,
    };
  }

  getDestroyable({ instance }: ClassicHelperStateBucket) {
    return instance;
  }

  getValue({ instance, args }: ClassicHelperStateBucket) {
    let { positional, named } = args;

    let ret = instance.compute(positional as DefaultPositional, named);

    consumeTag(instance[RECOMPUTE_TAG]);

    return ret;
  }

  getDebugName(definition: ClassHelperFactory) {
    return getDebugName!(((definition.class || definition)! as any)['prototype']);
  }
}

function isFactoryManager(obj: unknown): obj is InternalFactoryManager<object> {
  return obj != null && 'class' in (obj as InternalFactoryManager<object>);
}

setHelperManager((owner: InternalOwner | undefined): ClassicHelperManager => {
  return new ClassicHelperManager(owner);
}, Helper);

export const CLASSIC_HELPER_MANAGER = getInternalHelperManager(Helper);

///////////

class Wrapper<S = unknown> implements HelperFactory<SimpleHelper<S>> {
  readonly isHelperFactory = true;

  constructor(public compute: (positional: Positional<S>, named: Named<S>) => Return<S>) {}

  create() {
    // needs new instance or will leak containers
    return {
      compute: this.compute,
    };
  }
}

class SimpleClassicHelperManager implements HelperManager<() => unknown> {
  capabilities = helperCapabilities('3.23', {
    hasValue: true,
  });

  createHelper(definition: Wrapper, args: Arguments) {
    return () => definition.compute.call(null, args.positional as [], args.named);
  }

  getValue(fn: () => unknown) {
    return fn();
  }

  getDebugName(definition: Wrapper) {
    return getDebugName!(definition.compute);
  }
}

export const SIMPLE_CLASSIC_HELPER_MANAGER = new SimpleClassicHelperManager();

setHelperManager(() => SIMPLE_CLASSIC_HELPER_MANAGER, Wrapper.prototype);

/*
  Function-based helpers need to present with a constructor signature so that
  type parameters can be preserved when `helper()` is passed a generic function
  (this is particularly key for checking helper invocations with Glint).
  Accordingly, we define an abstract class and declaration merge it with the
  interface; this inherently provides an `abstract` constructor. Since it is
  `abstract`, it is not callable, which is important since end users should not
  be able to do `let myHelper = helper(someFn); new helper()`.
 */

/**
 * The type of a function-based helper.
 *
 * @note This is *not* user-constructible: it is exported only so that the type
 *   returned by the `helper` function can be named (and indeed can be exported
 *   like `export default helper(...)` safely).
 */
// Making `FunctionBasedHelper` an alias this way allows callers to name it in
// terms meaningful to *them*, while preserving the type behavior described on
// the `abstract class HelperFactory` above.
export type FunctionBasedHelper<S> = abstract new () => FunctionBasedHelperInstance<S>;

// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface FunctionBasedHelperInstance<S> extends SimpleHelper<S> {}
declare abstract class FunctionBasedHelperInstance<S> extends Helper<S> {
  protected abstract __concrete__: never;
}

/**
  In many cases it is not necessary to use the full `Helper` class.
  The `helper` method create pure-function helpers without instances.
  For example:

  ```app/helpers/format-currency.js
  import { helper } from '@ember/component/helper';

  export default helper(function([cents], {currency}) {
    return `${currency}${cents * 0.01}`;
  });
  ```

  @static
  @param {Function} helper The helper function
  @method helper
  @for @ember/component/helper
  @public
  @since 1.13.0
*/
// This overload allows users to write types directly on the callback passed to
// the `helper` function and infer the resulting type correctly.
export function helper<P extends DefaultPositional, N extends object, R = unknown>(
  helperFn: (positional: P, named: N) => R
): FunctionBasedHelper<{
  Args: {
    Positional: P;
    Named: N;
  };
  Return: R;
}>;
// This overload allows users to provide a `Signature` type explicitly at the
// helper definition site, e.g. `helper<Sig>((pos, named) => {...})`. **Note:**
// this overload must appear second, since TS' inference engine will not
// correctly infer the type of `S` here from the types on the supplied callback.
export function helper<S>(
  helperFn: (positional: Positional<S>, named: Named<S>) => Return<S>
): FunctionBasedHelper<S>;
// At the implementation site, we
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function helper(
  helperFn: (positional: unknown[], named: object) => unknown
): FunctionBasedHelper<any> {
  return new Wrapper(helperFn) as unknown as FunctionBasedHelper<any>;
}

/* eslint no-underscore-dangle: 0 */
import isPlainObject from 'is-plain-object';
import { logger } from '@storybook/client-logger';
import addons, { Addon, AddonStore } from '@storybook/addons';
import Events from '@storybook/core-events';
import { toId } from '@storybook/router/utils';

import mergeWith from 'lodash/mergeWith';
import isEqual from 'lodash/isEqual';
import get from 'lodash/get';
import { ClientApiParams, IDecoratorParams, IHierarchyObj, StoryStore, StoryFn } from './types';
import subscriptionsStore from './subscriptions_store';

// merge with concatenating arrays, but no duplicates
const merge = (a: IHierarchyObj, b: IHierarchyObj) =>
  mergeWith({}, a, b, (objValue, srcValue) => {
    if (Array.isArray(srcValue) && Array.isArray(objValue)) {
      srcValue.forEach(s => {
        const existing = objValue.find(o => o === s || isEqual(o, s));
        if (!existing) {
          objValue.push(s);
        }
      });

      return objValue;
    }
    if (Array.isArray(objValue)) {
      logger.log('the types mismatch, picking', objValue);
      return objValue;
    }
    return undefined;
  });

export const defaultDecorateStory = (storyFn: StoryFn, decorators: any[]) =>
  decorators.reduce(
    (decorated, decorator) => (context = {}) =>
      decorator(
        (p = {}) =>
          decorated(
            // MUTATION !
            Object.assign(
              context,
              p,
              { parameters: Object.assign(context.parameters || {}, p.parameters) },
              { options: Object.assign(context.options || {}, p.options) }
            )
          ),
        context
      ),
    storyFn
  );

const metaSubscription = () => {
  addons.getChannel().on(Events.REGISTER_SUBSCRIPTION, subscriptionsStore.register);
  return () =>
    addons.getChannel().removeListener(Events.REGISTER_SUBSCRIPTION, subscriptionsStore.register);
};

const withSubscriptionTracking = (storyFn: StoryFn) => {
  if (!addons.hasChannel()) {
    return storyFn();
  }
  subscriptionsStore.markAllAsUnused();
  subscriptionsStore.register(metaSubscription);
  const result = storyFn();
  subscriptionsStore.clearUnused();
  return result;
};

interface Addons {
  [key: string]: Addon;
}

export default class ClientApi {
  _storyStore: StoryStore;

  _addons: Addons;

  _globalDecorators: any[];

  _globalParameters: { [key: string]: any };

  _decorateStory: (storyFn: StoryFn, decorators: any) => any;

  constructor({ storyStore, decorateStory = defaultDecorateStory }: ClientApiParams) {
    this._storyStore = storyStore;
    this._addons = {};

    this._globalDecorators = [];
    this._globalParameters = {};
    this._decorateStory = decorateStory;

    if (!storyStore) {
      throw new Error('storyStore is required');
    }
  }

  setAddon = (addon: any) => {
    this._addons = {
      ...this._addons,
      ...addon,
    };
  };

  getSeparators = () =>
    Object.assign(
      {},
      {
        hierarchyRootSeparator: '|',
        hierarchySeparator: /\/|\./,
      },
      this._globalParameters.options
    );

  addDecorator = (decorator: () => any) => this._globalDecorators.push(decorator);

  addParameters = (parameters: IDecoratorParams[] | { globalParameter: 'string' }) => {
    this._globalParameters = {
      ...this._globalParameters,
      ...parameters,
      options: {
        ...merge(get(this._globalParameters, 'options', {}), get(parameters, 'options', {})),
      },
    };
  };

  clearDecorators = () => {
    this._globalDecorators = [];
  };

  // what are the occasions that "m" is simply a boolean, vs an obj
  storiesOf = (kind: string, m: any) => {
    if (!kind && typeof kind !== 'string') {
      throw new Error('Invalid or missing kind provided for stories, should be a string');
    }

    if (!m) {
      logger.warn(
        `Missing 'module' parameter for story with a kind of '${kind}'. It will break your HMR`
      );
    }

    if (m && m.hot && m.hot.dispose) {
      m.hot.dispose(() => {
        const { _storyStore } = this;
        _storyStore.remove(undefined);

        // TODO: refactor this
        // Maybe not needed at all if stories can just be overwriten ?
        this._storyStore.removeStoryKind(kind);
        this._storyStore.incrementRevision();
      });
    }

    const localDecorators: any[] | (() => void)[] = [];
    let localParameters = {};
    let hasAdded = false;
    const api = {
      kind,
    };

    // apply addons
    Object.keys(this._addons).forEach(name => {
      const addon = this._addons[name];
      api[name] = (...args: any[]) => {
        addon.apply(api, args);
        return api;
      };
    });

    api.add = (storyName: string, storyFn: StoryFn, parameters: any) => {
      hasAdded = true;
      const { _globalParameters, _globalDecorators } = this;

      const id = toId(kind, storyName);

      if (typeof storyName !== 'string') {
        throw new Error(`Invalid or missing storyName provided for a "${kind}" story.`);
      }
      if (m && m.hot && m.hot.dispose) {
        m.hot.dispose(() => {
          const { _storyStore } = this;
          _storyStore.remove(id);
        });
      }

      const fileName = m && m.id ? `${m.id}` : undefined;

      const { hierarchyRootSeparator, hierarchySeparator } = this.getSeparators();
      const baseOptions = {
        hierarchyRootSeparator,
        hierarchySeparator,
      };
      const allParam = [
        { options: baseOptions },
        _globalParameters,
        localParameters,
        parameters,
      ].reduce(
        (acc, p) => {
          if (p) {
            Object.entries(p).forEach(([key, value]) => {
              const existingValue = acc[key];

              if (Array.isArray(value)) {
                acc[key] = value;
              } else if (isPlainObject(value) && isPlainObject(existingValue)) {
                acc[key] = merge(existingValue, value);
              } else {
                acc[key] = value;
              }
            });
          }
          return acc;
        },
        { fileName }
      );

      this._storyStore.addStory(
        {
          id,
          kind,
          name: storyName,
          storyFn,
          parameters: allParam,
        },
        {
          applyDecorators: this._decorateStory,
          getDecorators: () => [
            ...(allParam.decorators || []),
            ...localDecorators,
            ..._globalDecorators,
            withSubscriptionTracking,
          ],
        }
      );
      return api;
    };

    api.addDecorator = (decorator: () => void) => {
      if (hasAdded) {
        logger.warn(`You have added a decorator to the kind '${kind}' after a story has already been added.
In Storybook 4 this applied the decorator only to subsequent stories. In Storybook 5+ it applies to all stories.
This is probably not what you intended. Read more here: https://github.com/storybookjs/storybook/blob/master/MIGRATION.md`);
      }

      localDecorators.push(decorator);
      return api;
    };

    api.addParameters = (parameters: any) => {
      localParameters = { ...localParameters, ...parameters };
      return api;
    };

    return api;
  };

  // legacy
  getStorybook = () =>
    this._storyStore.getStoryKinds().map(kind => {
      const fileName = this._storyStore.getStoryFileName(kind);

      const stories = this._storyStore.getStories(kind).map(name => {
        const render = this._storyStore.getStoryWithContext();
        return { name, render };
      });

      return { kind, fileName, stories };
    });

  raw = () => this._storyStore.raw();

  // FIXME: temporary expose the store for react-native
  // Longer term react-native should use the Provider/Consumer api
  store = () => this._storyStore;
}

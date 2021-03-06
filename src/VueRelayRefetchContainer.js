import buildVueRelayContainer from './buildVueRelayContainer'

const {
  RelayConcreteNode,
  Observable
} = require('relay-runtime')
const areEqual = require('fbjs/lib/areEqual')

const createContainerWithFragments = function (fragments, taggedNode) {
  const relay = this.relay

  return {
    name: 'relay-refetch-container',
    data () {
      const { createFragmentSpecResolver } = relay.environment.unstable_internal
      const resolver = createFragmentSpecResolver(
        relay,
        this.$options.name,
        fragments,
        this.$props,
        this._handleFragmentDataUpdate
      )

      return {
        // a.k.a this._relayContext in react-relay
        context: Object.freeze({
          relay: {
            environment: relay.environment,
            variables: relay.variables
          }
        }),
        state: Object.freeze({
          data: resolver.resolve(),
          prevProps: this.$props,
          relayEnvironment: relay.environment,
          relayVariables: relay.variables,
          relayProp: this._buildRelayProp(relay),
          localVariables: null,
          refetchSubscription: null,
          references: [],
          resolver
        })
      }
    },
    beforeUpdate () {
      const {
        createFragmentSpecResolver,
        getDataIDsFromObject
      } = relay.environment.unstable_internal

      const prevIDs = getDataIDsFromObject(fragments, this.state.prevProps)
      const nextIDs = getDataIDsFromObject(fragments, this.$props)

      // If the environment has changed or props point to new records then
      // previously fetched data and any pending fetches no longer apply:
      // - Existing references are on the old environment.
      // - Existing references are based on old variables.
      // - Pending fetches are for the previous records.
      if (
        this.state.relayEnvironment !== relay.environment ||
        this.state.relayVariables !== relay.variables ||
        !areEqual(prevIDs, nextIDs)
      ) {
        this._release()

        this.context.relay.environment = relay.environment
        this.context.relay.variables = relay.variables

        const resolver = createFragmentSpecResolver(
          relay,
          this.$options.name,
          fragments,
          this.$props,
          this._handleFragmentDataUpdate
        )

        this.setState({
          prevProps: this.$props,
          relayEnvironment: relay.environment,
          relayVariables: relay.variables,
          relayProp: this._buildRelayProp(relay),
          localVariables: null,
          resolver
        })
      } else if (!this.state.localVariables) {
        this.state.resolver.setProps(this.$props)
      }
      const data = this.state.resolver.resolve()
      if (data !== this.state.data) {
        this.setState({ data })
      }
    },
    beforeDestroy () {
      this._release()
    },
    methods: {
      setState (state) {
        this.state = Object.freeze({
          ...this.state,
          ...state
        })
      },
      _buildRelayProp (relay) {
        return {
          environment: relay.environment,
          refetch: this._refetch
        }
      },
      _handleFragmentDataUpdate () {
        this.setState({
          data: this.state.resolver.resolve()
        })
      },
      _getFragmentVariables () {
        const {
          getVariablesFromObject
        } = relay.environment.unstable_internal
        return getVariablesFromObject(
          relay.variables,
          fragments,
          this.$props
        )
      },
      _refetch (refetchVariables, renderVariables, observerOrCallback, options) {
        const { environment, variables: rootVariables } = relay
        const {
          createOperationSelector,
          getRequest
        } = environment.unstable_internal
        let fetchVariables =
          typeof refetchVariables === 'function'
            ? refetchVariables(this._getFragmentVariables())
            : refetchVariables
        fetchVariables = { ...rootVariables, ...fetchVariables }
        const fragmentVariables = renderVariables
          ? { ...rootVariables, ...renderVariables }
          : fetchVariables
        this.setState({ localVariables: fetchVariables })

        const cacheConfig = options ? { force: !!options.force } : void 0

        const observer =
          typeof observerOrCallback === 'function'
            ? {
              // callback is not exectued on complete or unsubscribe
              // for backward compatibility
              next: observerOrCallback,
              error: observerOrCallback
            }
            : observerOrCallback || ({})

        const request = getRequest(taggedNode)
        if (request.kind === RelayConcreteNode.BATCH_REQUEST) {
          throw new Error(
            'RelayRefetchContainer: Batch request not yet ' +
              'implemented (T22955000)'
          )
        }
        const operation = createOperationSelector(request, fetchVariables)

        // Immediately retain the results of the query to prevent cached
        // data from being evicted
        const reference = environment.retain(operation.root)
        this.state.references.push(reference)

        // Cancel any previously running refetch.
        if (this.state.refetchSubscription) {
          this.state.refetchSubscription.unsubscribe()
        }

        // Declare refetchSubscription before assigning it in .start(), since
        // synchronous completion may call callbacks .subscribe() returns.
        let refetchSubscription

        environment
          .execute({ operation, cacheConfig })
          .mergeMap(response => {
            this.context.relay.environment = relay.environment
            this.context.relay.variables = fragmentVariables
            this.state.resolver.setVariables(fragmentVariables)
            return Observable.create(sink => {
              this.setState({ data: this.state.resolver.resolve() })
              sink.next()
              sink.complete()
            })
          })
          .finally(() => {
            // Finalizing a refetch should only clear this._refetchSubscription
            // if the finizing subscription is the most recent call.
            if (this.state.refetchSubscription === refetchSubscription) {
              this.state.refetchSubscription.unsubscribe()
              this.setState({
                refetchSubscription: null
              })
            }
          })
          .subscribe({
            ...observer,
            start: subscription => {
              refetchSubscription = subscription
              this.setState({
                refetchSubscription: subscription
              })
              observer.start && observer.start(subscription)
            }
          })

        return {
          dispose () {
            refetchSubscription && refetchSubscription.unsubscribe()
          }
        }
      }
    }
  }
}

const createRefetchContainer = function (fragmentSpec, taggedNode) {
  return buildVueRelayContainer(fragmentSpec, function (fragments) {
    return createContainerWithFragments.call(this, fragments, taggedNode)
  })
}

export {
  createRefetchContainer
}

var path = require('path')
var http = require('http')
var merge = require('lodash.merge')
var express = require('express')
var difference = require('lodash.difference')

/**
 * ExpressAdapter constructor
 */
var ExpressAdapter = module.exports = function() {
  this.app = express()
}

/**
 * Get the instance of express app.
 *
 * @return {Express} A instance of express app
 */
ExpressAdapter.prototype.getApp = function() {
  return this.app
}

ExpressAdapter.prototype.startServer = function(port, host) {
  var app = this.getApp()

  if (1 === arguments.length && 'function' === typeof port) {
    // port is an express app
    this.mainApp = port

    // attach our `app` to the main express app
    this.mainApp.use(app)
    return Promise.resolve()
  }

  var promise = new Promise(function(resolve, reject) {
    var server = app.listen(port, host, function(error) {
      error ? reject(error) : resolve(server)
    })
  })

  return promise
}

/**
 * Allow upgraded requests proxy to the backend services. It will only be called
 * when micromono runs in the balancer mode.
 *
 * @param  {String} url   The url which allows upgraded requests
 * @param {Function}     The handler function which takes
 *                        `req` (http.IncomingMessage) and
 *                        `res` (http.ServerResponse) as
 *                        arguments and do the actual proxy.
 * @param  {Router}   router  The instance of Router.
 * @param  {Service}  service The service instance.
 * @return {ExpressAdapter}   The instance of this adpater.
 */
ExpressAdapter.prototype.allowUpgrade = function(url, handler, router, service) {
  this.app.use(url, handler)
  return this
}

/**
 * Attach a single route to express app.
 *
 * @param  {Object} route     The route definition object which has following format:
 *
 * ```javascript
 * {
 *   name: 'get::/user/:name',
 *   method: 'get',
 *   path: '/user/:name',
 *   handler: [Function],
 *   args: ['req', 'res'],
 *   middleware: null
 * }
 * ```
 *
 * @param  {Router}   router  The instance of Router.
 * @param  {Service}  service The service instance.
 * @return {ExpressAdapter}   The instance of this adpater.
 */
ExpressAdapter.prototype.attachRoute = function(route, router, service) {
  var method = route.method.toLowerCase()
  var routePath = path.join(service.baseUrl, route.path)

  if (route.middleware) {
    this.app[method](routePath, route.middleware.map(function(m) {
      return m.bind(service)
    }), route.handler.bind(service))
  } else {
    this.app[method](routePath, route.handler.bind(service))
  }

  return this
}

/**
 * Serve the static asset files accroding to service settings.
 *
 * @param  {Asset}    asset   The instance of asset.
 * @param  {Router}   router  The instance of Router.
 * @param  {Service}  service The service instance.
 * @return {ExpressAdapter}   The instance of this adpater.
 */
ExpressAdapter.prototype.serveAsset = function(asset, router, service) {
  var app = this.getApp()
  var publicURL = asset.getPublicURL()

  if (service.isRemote()) {
    // proxy requests for static asset
    var assetHandler = router.getProxyHandler()
    publicURL.forEach(function(url) {
      var assetUrl = path.join(url, '*')
      app.get(assetUrl, assetHandler)
    })
  } else {
    var publicPath = asset.getPublicPath()
    publicURL.forEach(function(url) {
      app.use(url, express.static(publicPath))
    })
  }

  return this
}

/**
 * Attach a single middleware to express app.
 *
 * @param  {Object} middleware The middleware definition object which has following format:
 *
 * ```javascript
 * {
 *   // the name of the middleware
 *   name: 'auth',
 *   // relative path to the middleware
 *   path: '/account/middleware/auth',
 *   // the function for generating handler function
 *   handler: function() {
 *     ...
 *     return function(req, res, next) {...}
 *   }
 * }
 *
 * ```
 *
 * @param  {Router}   router  The instance of Router.
 * @param  {Service}  service The service instance.
 * @return {ExpressAdapter}   The instance of this adpater.
 */
ExpressAdapter.prototype.attachMiddleware = function(middleware, router, service) {

  if (service.isRemote()) {
    this._attachRemoteMiddleware(middleware, router, service)
  } else {
    this._attachLocalMiddleware(middleware, router, service)
  }

  return this
}

// Private function for attaching local middlewares
ExpressAdapter.prototype._attachLocalMiddleware = function(middleware, router, service) {
  var app = this.getApp()

  // @todo support middleware options
  middleware.handler = middleware.handler.bind(service)
  var handlerFn = middleware.handler()

  app.use(middleware.path, function(req, res, next) {
    var semi = true

    // find out if the middleware wants to alter response
    var _writeHead = req.writeHead
    var _write = req.write
    var _end = req.end

    // record changes of `req` and `req.headers`
    var reqKeys = Object.keys(req)
    var headerKeys = Object.keys(req.headers)

    handlerFn(req, res, function(err) {
      semi = _writeHead === req.writeHead && _write === req.write && _end === req.end

      if (err) {
        res.writeHead(500, 'MicroMono middleware error.')
        res.end()
        return
      }

      if (semi) {
        // using a non-exists status code to indicate that the middleware
        // does not need to change the response
        res.statusCode = 103

        // we only care about properties which have been added to the `req`
        // object
        var changedReqKeys = difference(Object.keys(req), reqKeys)
        var changedHeaderKeys = difference(Object.keys(req.headers), headerKeys)

        var _req = {}
        var _headers = {}

        changedReqKeys.forEach(function(key) {
          if (key !== 'read') { // @todo add more ignored names here
            _req[key] = req[key]
          }
        })

        changedHeaderKeys.forEach(function(key) {
          _headers[key] = req.headers[key]
        })

        if (Object.keys(_headers).length > 0) {
          _req.headers = _headers
        }

        if (Object.keys(_req).length > 0) {
          res.setHeader('X-MicroMono-Req', JSON.stringify(_req))
        }

        res.end()
      } else {
        // let the request go if this is a fully-remote middleware
        next()
      }
    })
  })
}

// Private function for processing remote middleware. This will not attach the
// middleware to the internal express app. Instead, it rebuilds the remote
// middleware handler so it could be used locally.
ExpressAdapter.prototype._attachRemoteMiddleware = function(middleware, router, service) {
  var _path = middleware.path

  // @todo support remote middleware options
  var handler = function() {
    return function(req, res, next) {
      service.scheduleProvider(function(provider) {
        // @todo this is a naive proxy implementation.
        var proxyReq = http.request({
          host: provider.address,
          port: provider.webPort,
          path: _path,
          headers: req.headers
        }, function(proxyRes) {
          if (proxyRes.statusCode === 103) {
            var reqMerge = proxyRes.headers['x-micromono-req']
            if (reqMerge) {
              try {
                reqMerge = JSON.parse(reqMerge)
                merge(req, reqMerge)
              } catch (e) {}
            }
            next()
          } else {
            res.set(proxyRes.headers)
            res.statusCode = proxyRes.statusCode
            proxyRes.pipe(res)
          }
        })

        proxyReq.on('error', function(err, req, res) {
          res.writeHead(500, {
            'Content-Type': 'text/plain'
          })

          res.end('Proxy error')
        })

        req.pipe(proxyReq)
      })
    }
  }

  service.middleware[name] = handler
}
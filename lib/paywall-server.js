// ----------------------------------------------------------------------------
//
// Enuma Sprites PoC
//
// Copyright (c) 2018 Enuma Technologies Limited.
// https://www.enuma.io/
// ----------------------------------------------------------------------------

const path = require('path')
const {map, indexBy, prop} = require('ramda')
const express = require('express')
const cors = require('cors')
const errorhandler = require('errorhandler')
const Jayson = require('./jayson.js')
const Web3Eth = require('web3-eth')
const {waitForAccounts} = require('./test-helpers.js')
const OffChainRegistry = require('./off-chain-registry.js')
const Sprites = require('./sprites.js')
const Paywall = require('./paywall.js')
const PaywallApi = require('./paywall-api.js')
const LoremIpsum = require('lorem-ipsum')
const serverPort = 3000
const ethUrl = 'http://localhost:8545'
const web3Provider = new Web3Eth.providers.HttpProvider(ethUrl)
const {accounts, ...spritesConfig} =
    Jayson.load(path.join(__dirname, 'sprites-config.json'))

const newArticle = (id) => {
    const content = LoremIpsum({count:5, units:'paragraphs'})
    return {
        id: `aId-${id}`,
        price: 10 + id,
        title: LoremIpsum({count:5, units:'words'}),
        content: content,
        blurb: content.split('\n')[0]
    }
}

const Articles = map(newArticle, range(0, 2 + 1))
const ArticleDB = indexBy(prop('id'), Articles)

const ownAddress = accounts.BOB

const paywall = {
    ...Paywall.new(),
    db: ArticleDB,
    sprites: thread({
            ...spritesConfig,
            web3Provider,
            ACTOR_NAME: 'Paywall Operator',
            ownAddress,
            offChainReg: new OffChainRegistry({ownAddress})
        },
        Sprites.withRemoteSigner,
        Sprites.withWeb3Contracts),
}

const paywallApi = PaywallApi(paywall, express.Router())
const jsonError = function (error, req, res, next) {
    log(error)
    const {message, stack} = error
    res.send({message, stack})
}

const server = express()
    .use(cors())
    .use('/', paywallApi)
    // .use(errorhandler())
    .use(jsonError)

async function start() {
    await waitForAccounts(web3Provider)
    await new Promise(resolve => server.listen(serverPort, resolve))
    log(`Paywall API server listening at http://localhost:${serverPort}`)
}

start()
    .catch(err => console.error(err))

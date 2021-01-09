const { Telegraf, Telegram } = require("telegraf")
const config = require("./config")
const db = require("./db")
const fs = require("fs")
const {arrayRandom, trueTrim, plusminus, pluralize} = require("./functions")
const telegram = new Telegram(config.token)
const bot = new Telegraf(config.token)

let gameStates = {}
const createGameState = chatId => {
	gameStates[chatId] = {
		timeouts: {},
		guessMessage: null,
		currentRound: null,
		currentTime: 0,
		answersOrder: []
	}
	return gameStates[chatId]
}
const getGreetMessage = isGroup => trueTrim(`
	Salam! Mən domino oyunu üçün yaradılmış botam!
`)
const getRandomPerson = () => {
	let imagePath = "./photos"
	let fimeName = arrayRandom(fs.readdirSync(imagePath))
	let age = Number(fimeName.match(/^(\d+)/)[1])
	return {
		age: age,
		photo: `${imagePath}/${fimeName}`
	}
}
const iterateObject = (obj, f) => {
	let index = 0
	for (let key in obj) {
		f(key, obj[key], index)
		index++
	}
}
const createChat = chatId => {
	let data = {
		isPlaying: true,
		members: {}
	}
	db.insert(chatId, data)
}
const createMember = firstName => {
	return {
		firstName: firstName,
		isPlaying: true,
		answer: null,
		gameScore: 0,
		totalScore: 0
	}
}
const getChat = chatId => {
	return db.get(chatId)
}
const stopGame = (ctx, chatId) => {
	let chat = getChat(chatId)
	if (chat && chat.isPlaying) {
		if (gameStates[chatId] && gameStates[chatId].timeouts) {
			for (let key in gameStates[chatId].timeouts) {
				clearTimeout(gameStates[chatId].timeouts[key])
			}
		}
		chat.isPlaying = false
		let top = []
		iterateObject(chat.members, (memberId, member, memberIndex) => {
			if (member.isPlaying) {
				top.push({
					firstName: member.firstName,
					score: member.gameScore
				})

				Object.assign(member, {
					answer: null,
					isPlaying: false,
					gameScore: 0
				})
			}
		})
		db.update(chatId, ch => chat)
		if (top.length > 0) {
			ctx.replyWithMarkdown(trueTrim(`
				*🏁 Qaliblər:*

				${top.sort((a, b) => b.score - a.score).map((member, index) => `${["🏆","🎖","🏅"][index] || "🔸"} ${index + 1}. *${member.firstName}*: ${member.score} ${pluralize(member.score, "xal", "xal", "xal")}`).join("\n")}

				❤️ Rəsmi kanala abunə olun: .
				🔄 /game - Oynayaq?
			`))
		}
	}
	else {
		ctx.reply("❌ Oyun başlamayıb! /start Komandası ilə oyun başlada bilmərsiniz.")
	}
}
const getRoundMessage = (chatId, round, time) => {
	let chat = getChat(chatId)
	let answers = []
	iterateObject(chat.members, (memberId, member, memberIndex) => {
		if (member.isPlaying && member.answer !== null) {
			answers.push({
				answer: member.answer,
				firstName: member.firstName,
				memberId: Number(memberId)
			})
		}
	})
	answers = answers.sort((a, b) => gameStates[chatId].answersOrder.indexOf(a.memberId) - gameStates[chatId].answersOrder.indexOf(b.memberId))

	return trueTrim(`
		*Raund ${round + 1}/${config.rounds}*
		Sizcə burada neçə xal var?
		${answers.length > 0 ? 
			`\n${answers.map((member, index) => `${index + 1}. *${member.firstName}*: ${member.answer}`).join("\n")}\n`
			:
			""
		}
		${"⬛".repeat(time)}${"⬜".repeat(config.timerSteps - time)}
	`)
}
const startGame = (ctx, chatId) => {
	let gameState = createGameState(chatId)
	let startRound = async round => {
		let person = getRandomPerson()
		let rightAnswer = person.age
		let guessMessage = await ctx.replyWithPhoto({
			source: person.photo,
		}, {
			caption: getRoundMessage(chatId, round, 0),
			parse_mode: "Markdown"
		})
		gameState.currentTime = 0
		gameState.guessMessageId = guessMessage.message_id
		gameState.currentRound = round

		let time = 1
		gameState.timeouts.timer = setInterval(() => {
			gameState.currentTime = time
			telegram.editMessageCaption(
				ctx.chat.id,
				guessMessage.message_id,
				null,
				getRoundMessage(chatId, round, time),
				{
					parse_mode: "Markdown"
				}
			)
			time++
			if (time >= (config.timerSteps + 1)) clearInterval(gameState.timeouts.timer)
		}, config.waitDelay / (config.timerSteps + 1))
		
		gameState.timeouts.round = setTimeout(() => {
			let chat = getChat(chatId)
			let top = []
			iterateObject(chat.members, (memberId, member, memberIndex) => {
				if (member.isPlaying) {
					let addScore = member.answer === null ? 0 : rightAnswer - Math.abs(rightAnswer - member.answer)
					chat.members[memberId].gameScore += addScore
					chat.members[memberId].totalScore += addScore
					top.push({
						firstName: member.firstName,
						addScore: addScore,
						answer: member.answer
					})
					member.answer = null
					db.update(chatId, ch => chat)
				}
			})
			db.update(chatId, ch => chat)
			
			if (!top.every(member => member.answer === null)) {
				ctx.replyWithMarkdown(
					trueTrim(`
						Bu dominolarda vardı: *${rightAnswer} ${pluralize(rightAnswer, "daş", "daş", "daş")}*. Cavaba yaxın olanlar:

						${top.sort((a, b) => b.addScore - a.addScore).map((member, index) => `${["🏆","🎖","🏅"][index] || "🔸"} ${index + 1}. *${member.firstName}*: ${plusminus(member.addScore)}`).join("\n")}
					`),
					{
						reply_to_message_id: guessMessage.message_id,
					}
				)
			}
			else {
				ctx.reply("🤔 Deyəsən oynamırsan! Oyunu bitirirəm...")
				stopGame(ctx, chatId)
				return
			}

			if (round === config.rounds - 1) {
				gameState.timeouts.stopGame = setTimeout(() => {
					stopGame(ctx, chatId)
				}, 1000)
			}
			else {
				gameState.answersOrder = []
				gameState.timeouts.afterRound = setTimeout(() => {
					startRound(++round)
				}, 2500)
			}
		}, config.waitDelay)
	}
	gameState.timeouts.beforeGame = setTimeout(() => {
		startRound(0)
	}, 1000)
}

bot.catch((err, ctx) => {
	console.log("\x1b[41m%s\x1b[0m", `Ooops, encountered an error for ${ctx.updateType}`, err)
})

bot.start(async (ctx) => {
	ctx.replyWithMarkdown(getGreetMessage(ctx.update.message.chat.id < 0))
})

bot.command("game", (ctx) => {
	let message = ctx.update.message
	if (message.chat.id < 0) {
		let chatId = message.chat.id
		let chat = getChat(chatId)
		if (chat) {
			if (chat.isPlaying) {
				return ctx.reply("❌ Oyun davam edir! Bitirmək üçün /stop.")
			}
			else {
				chat.isPlaying = true
				for (let key in chat.members) {
					let member = chat.members[key]
					member.gameScore = 0
				}
				db.update(chatId, ch => chat)
			}
		}
		else {
			createChat(chatId)
		}
		ctx.replyWithMarkdown("*Oyun başlayır!*")
		startGame(ctx, chatId)
	}
	else {
		ctx.reply("❌ Bu komanda çat üçündür.")
	}
})

bot.command("stop", (ctx) => {
	let message = ctx.update.message
	if (message.chat.id < 0) {
		let chatId = message.chat.id
		stopGame(ctx, chatId)
	}
	else {
		ctx.reply("❌ Bu komanda çat üçündür.")
	}
})

bot.command("donate", (ctx) => {
	return ctx.replyWithMarkdown(trueTrim(`
		Вот список доступных кошельков.

		Яндекс.Деньги: \`410018465529632\`
		QIWI: \`+77025852595\`
		BTC: \`1MDRDDBURiPEg93epMiryCdGvhEncyAbpy\`
		Kaspi (Казахстан): \`5169497160435198\`
	`))
})

bot.command("top", (ctx) => {
	let message = ctx.update.message
	if (message.chat.id < 0) {
		let chatId = message.chat.id
		let chat = getChat(chatId)
		if (chat) {
			let top = []
			iterateObject(chat.members, (memberId, member, memberIndex) => {
				top.push({
					firstName: member.firstName,
					score: member.totalScore
				})

				Object.assign(member, {
					answer: null,
					isPlaying: false,
					gameScore: 0
				})
			})
			if (top.length > 0) {
				ctx.replyWithMarkdown(trueTrim(`
					*🔝 Bu çat üçün TOP oyunçular:*

					${top.sort((a, b) => b.score - a.score).map((member, index) => `${["🏆","🎖","🏅"][index] || "🔸"} ${index + 1}. *${member.firstName}*: ${member.score} ${pluralize(member.score, "xal", "xal", "xal")}`).join("\n")}

					❤️ Rəsmi kanala abunə olun: .
					🔄 /game - Oynayaq?
				`))
			}
			else {
				ctx.reply("❌ Siz hələ bu çatda oynamamısınız.")
			}
		}
		else {
			ctx.reply("❌ Siz hələ bu çatda oynamamısınız.")
		}
	}
	else {
		ctx.reply("❌ Bu komanda çat üçündür.")
	}
})

bot.on("message", async (ctx) => {
	let message = ctx.update.message
	if (message.chat.id < 0) {
		let chatId = message.chat.id
		let fromId = message.from.id
		let chat = getChat(chatId)
		if (
			chat && //chat exist
			chat.isPlaying && //game exist
			(chat.members[fromId] === undefined || chat.members[fromId].answer === null) && //it's a new member or it's member's first answer
			gameStates && //gameState was created
			/^-?\d+$/.test(message.text)
		) {
			let firstName = message.from.first_name
			let answer = Number(message.text)
			if (answer <= 0 || answer > 120) {
				return ctx.reply(
					"Bu diapazonda cavab qəbul olunmur (1 - 120)",
					{
						reply_to_message_id: ctx.message.message_id,
					}
				)
			}
			if (!chat.members[fromId]) { //new member's answer
				chat.members[fromId] = createMember(firstName)
			}
			Object.assign(chat.members[fromId], {
				isPlaying: true,
				answer: answer,
				firstName: firstName
			})
			gameStates[chatId].answersOrder.push(fromId)

			db.update(chatId, ch => chat)

			telegram.editMessageCaption(
				chatId,
				gameStates[chatId].guessMessageId,
				null,
				getRoundMessage(chatId, gameStates[chatId].currentRound, gameStates[chatId].currentTime),
				{
					parse_mode: "Markdown"
				}
			)
		}
		else if (message.new_chat_member && message.new_chat_member.id === config.botId) { //bot added to new chat
			ctx.replyWithMarkdown(getGreetMessage(true))
		}
	}
})

bot.launch();

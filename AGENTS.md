READ more about whatsapp-web.js at: https://docs.wwebjs.dev/

- build a whasapp js bot
- at the start always send the video at assets/Introduction_Video.mp4
1 integrate openai that will use openrouter
2 the ai will detect intents and respond accordingly
3 the intents could be one of the following:
3.3 - just saying welcome or greeting -> send the asset at assets/welcome-message.jpeg
3.4 - asking about the shipping -> send the asset at assets/livraison-details.jpeg
3.5 - wants to make an order -> collect the name, city, street, and the phone number. make sure to collect all the informations
3.6 - general intent -> the ai will respond to any other request with a general message.
4 - after collecting the informations, store them in pocketbase under "orders" collection.

Not To Do:
- no AI hallucinations or false informations about the product, only work with what's available.

Expected:
- clean and consistent AI responses.
- a bot that answers any user questions with the right information.
- a bot that registers new orders and stores them in pocketbase.

- you can find more about the business details at /assets/business-details.txt

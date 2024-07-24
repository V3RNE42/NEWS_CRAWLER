### ENGLISH


# NodeJS Webcrawler/Newsletter based on Sendgrid and OpenAI APIs

Welcome to the NodeJS Webcrawler Newsletter! This newsletter aims to provide you with the latest updates, tips, and resources related to whatever you want! It's defaulted to Spanish newspapers and international security issues, but you can adapt it to your own needs! :^)

## Table of Contents

- [NodeJS Webcrawler/Newsletter based on Sendgrid and OpenAI APIs](#nodejs-webcrawlernewsletter-based-on-sendgrid-and-openai-apis)
  - [Table of Contents](#table-of-contents)
  - [Introduction](#introduction)
  - [Usage](#usage)
  - [Installation](#installation)
    - [Configuration Guide](#configuration-guide)
    - [Customization Guide](#customization-guide)
    - [SPANISH](#spanish)
- [NodeJS Webcrawler/Newsletter basado en Sendgrid y OpenAI APIs](#nodejs-webcrawlernewsletter-basado-en-sendgrid-y-openai-apis)
  - [Introducción](#introducción)
  - [Uso](#uso)
  - [Instalación](#instalación)
    - [Guía de Configuración](#guía-de-configuración)
    - [Guía de Personalización](#guía-de-personalización)

## Introduction

This is a NodeJS-based project for daily webcrawling of news sites looking for certain terms, then emailing those results if they're from the last 24 hours.
You can download it and use it as you please.

## Usage

To use this NodeJS webcrawler newsletter, follow these steps:

1. Clone the repository to your local machine.
2. Install the required dependencies by running the following command in your terminal:

    ```
      npm init -y
      npm install
    ```

3. Configure the webcrawler by updating the `config.json` file with your desired settings. You can specify the target website, crawling depth, and other parameters. Refer to the [Configuration Guide](#configuration-guide) for more details.

4. Customize the webcrawler behavior by modifying the `terminos.js` file. This file contains the terms that the webcrawler will search for on the target website. Refer to the [Customization Guide](#customization-guide) for more details.

5. Run the webcrawler by executing the following command:

    ```
    npm start
    ```

    This will start the webcrawler and it will begin crawling the target website based on the provided configuration.

6. Monitor the webcrawler's progress and results. The webcrawler will output the crawled data to the console and also save it to a file for further analysis.

## Installation

To install and run this NodeJS webcrawler newsletter, please follow these steps:

1. Install NodeJS on your local machine if you didn't already.

2. Clone the repository to your local machine.

3. Navigate to the project directory in your terminal.

4. Install the dependencias with `npm install`

5. Once the installation is complete, you can proceed to the usage section to configure and run the webcrawler.

### Configuration Guide

The `config.json` file allows you to customize the behavior of the webcrawler. Here are some key settings you can modify:

- `sender`: Specify the email of the sender with an associated smtp.sendgrid account
- `recipients`: Specify the email of the people receiving your emails.
- `email`: Set the hour from which the emails can be sent - obviously won't start until that hour is reached 
- `api_key`: Set your current OpenAI API key to use the GPT-4 model for generating some email summaries.
- `smtp_pass`: Set the SendGrid API key of your account
- `topic_sensitivity`: Set the topic sensitivity -> The bigger the sensitivity, the less false positives will be added, but also the total amount of scraped articles - More false negatives (ranges from 1 to ∞)
- `language`: Set the language in which the news articles will be found
- `ignore_redundancy`: Tells the program wether or not to get rid of redundant articles. It's set to `false` by default, which tells the program to remove those pesky redundant articles.

### Customization Guide

The `terminos.js` file contains the terms that the webcrawler will search for on the target websites. You can customize this file by adding or removing **terms** based on your specific requirements. Same applies for **websites**.

### SPANISH

# NodeJS Webcrawler/Newsletter basado en Sendgrid y OpenAI APIs

¡Bienvenido al Newsletter basado en webcrawling con NodeJS! Está predeterminado a periódicos españoles y temas de seguridad internacional, pero puedes adaptarlo a tus propias necesidades. :^)

## Introducción

Este es un proyecto basado en NodeJS para la webcrawling diaria de sitios de noticias en busca de ciertos términos, y luego enviar esos resultados por correo electrónico si son de las últimas 24 horas. 
Puedes descargarlo y usarlo como desees.

## Uso

Para utilizar esta newsletter de webcrawler de NodeJS, sigue estos pasos:

1. Clona el repositorio a tu máquina local.
2. Instala las dependencias necesarias ejecutando en la consola:

    ```bash
      npm init -y
      npm install
    ```

3. Configura el webcrawler actualizando el archivo `config.json` con tus ajustes deseados. Puedes especificar el sitio web objetivo, la profundidad del crawling y otros parámetros. Consulta la [Guía de Configuración](#guía-de-configuración) para más detalles.

4. Personaliza el comportamiento del webcrawler modificando el archivo `terminos.js`. Este archivo contiene los términos que el webcrawler buscará en el sitio web objetivo. Consulta la [Guía de Personalización](#guía-de-personalización) para más detalles.

5. Ejecuta el webcrawler ejecutando el siguiente comando:

    ```bash
    npm start
    ```

    Esto iniciará el webcrawler y comenzará a rastrear el sitio web objetivo según la configuración proporcionada.

6. Monitorea el progreso y los resultados del webcrawler. El webcrawler imprimirá los datos rastreados en la consola y también los guardará en un archivo para un análisis posterior.

## Instalación

Para instalar y ejecutar esta newsletter de webcrawler de NodeJS, sigue estos pasos:

1. Instala NodeJS en tu máquina local si aún no lo has hecho.

2. Clona el repositorio a tu máquina local.

3. Navega al directorio del proyecto en tu terminal.

4. Instala las dependencias ejecutando `npm install` en la consola.

5. Una vez completada la instalación, puedes proceder a la sección de uso para configurar y ejecutar el webcrawler.

### Guía de Configuración

El archivo `config.json` te permite personalizar el comportamiento del webcrawler. Aquí hay algunas configuraciones clave que puedes modificar:

- `sender`: Especifica el correo electrónico del remitente con una cuenta asociada smtp.sendgrid
- `recipients`: Especifica el correo electrónico de las personas que recibirán tus correos electrónicos.
- `email`: Establece la hora a la cual se envían los correos electrónicos
- `api_key`: Establece tu clave API actual de OpenAI para usar el modelo GPT-4 para generar algunos resúmenes de correos electrónicos.
- `smtp_pass`: Establece la clave API de SendGrid de tu cuenta
- `topic_sensitivity`: Establece la sensibilidad temática -> A mayor sensibilidad, menos posibles falsos positivos quedan añadidos, pero también se reduce el número total de artículos recogidos - Más falsos negativos (Va de 1 a ∞)
- `language`: Establece el lenguage en que se van a encontrar las noticias recogidas
- `ignore_redundancy`: Le indica al programa si debe desechar los artículos redundantes. Por defecto está en `false`, lo cual indica que deberían eliminarse.

### Guía de Personalización

El archivo `terminos.js` contiene los términos que el webcrawler buscará en los sitios web objetivo. Puedes personalizar este archivo añadiendo o eliminando **términos** según tus requisitos específicos. Lo mismo aplica para **sitios web**.

# Generated by Django 2.2.13 on 2020-12-15 13:45

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('numbas_lti', '0059_remarkedscormelement'),
    ]

    operations = [
        migrations.AlterModelOptions(
            name='attemptlaunch',
            options={'ordering': ('-time',)},
        ),
        migrations.AlterModelOptions(
            name='ltilaunch',
            options={'ordering': ('-time',)},
        ),
        migrations.AlterField(
            model_name='resource',
            name='max_attempts',
            field=models.PositiveIntegerField(default=0, help_text='Zero means unlimited attempts.', verbose_name='Maximum attempts per user'),
        ),
    ]